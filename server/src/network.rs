use crate::{auth, protocol, world};
use auth::{Credentials, Request};
use axum::{
    extract::{
        rejection::JsonRejection,
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use protocol::{reject, ClientMessage, CONTENT_VERSION, PROTOCOL_VERSION};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, Semaphore};
#[derive(Clone)]
pub struct App {
    pub auth: mpsc::Sender<Request>,
    pub world: mpsc::Sender<world::Command>,
    pub auth_slots: Arc<Semaphore>,
    pub connections: Arc<Semaphore>,
}
pub fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({"error":message}))).into_response()
}
async fn credentials(
    app: App,
    body: Result<Json<Credentials>, JsonRejection>,
    register: bool,
) -> Response {
    let Ok(_slot) = app.auth_slots.try_acquire() else {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication busy; retry shortly",
        );
    };
    let Ok(Json(c)) = body else {
        return error(StatusCode::BAD_REQUEST, "Invalid credentials JSON");
    };
    if !c.validate() {
        return error(
            StatusCode::BAD_REQUEST,
            "Username: 3-32 ASCII letters/digits/_/-. Password: 8-128 UTF-8 bytes",
        );
    }
    // Bounded auth work and a minimum request interval limit password-hashing pressure.
    let started = Instant::now();
    let response = if register {
        let (tx, rx) = oneshot::channel();
        if app.auth.try_send(Request::Register(c, tx)).is_err() {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Authentication queue full");
        }
        match rx.await {
            Ok(Ok(())) => {
                (StatusCode::CREATED, Json(serde_json::json!({"ok":true}))).into_response()
            }
            Ok(Err(e)) => error(
                if e == "username already exists" {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR
                },
                &e,
            ),
            Err(_) => error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Authentication unavailable",
            ),
        }
    } else {
        let (tx, rx) = oneshot::channel();
        if app.auth.try_send(Request::Login(c, tx)).is_err() {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Authentication queue full");
        }
        match rx.await { Ok(Ok((identity,token)))=>Json(serde_json::json!({"token":token,"playerId":identity.id,"username":identity.username,"protocolVersion":PROTOCOL_VERSION,"contentVersion":CONTENT_VERSION})).into_response(), Ok(Err(e))=>error(StatusCode::UNAUTHORIZED,&e), Err(_)=>error(StatusCode::SERVICE_UNAVAILABLE,"Authentication unavailable") }
    };
    tokio::time::sleep(Duration::from_millis(500).saturating_sub(started.elapsed())).await;
    response
}
pub async fn register(
    State(app): State<App>,
    body: Result<Json<Credentials>, JsonRejection>,
) -> Response {
    credentials(app, body, true).await
}
pub async fn login(
    State(app): State<App>,
    body: Result<Json<Credentials>, JsonRejection>,
) -> Response {
    credentials(app, body, false).await
}
pub async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    let Ok(slot) = app.connections.clone().try_acquire_owned() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Connection capacity reached",
        );
    };
    ws.max_message_size(2048)
        .max_frame_size(2048)
        .on_upgrade(move |socket| async move {
            let _slot = slot;
            socket_loop(socket, app).await
        })
        .into_response()
}
async fn send(socket: &mut WebSocket, text: String) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            socket.send(Message::Text(text.into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn socket_loop(mut socket: WebSocket, app: App) {
    let first = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return;
    };
    let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else {
        let _ = send(
            &mut socket,
            reject("invalid_hello", "Expected versioned hello", None),
        )
        .await;
        return;
    };
    if !message.valid() {
        let _ = send(
            &mut socket,
            reject(
                "invalid_hello",
                "Invalid token or incompatible protocol/content version",
                None,
            ),
        )
        .await;
        return;
    }
    let ClientMessage::Hello { token, lang, .. } = message else {
        let _ = send(
            &mut socket,
            reject("unauthenticated", "Hello required", None),
        )
        .await;
        return;
    };
    let (reply, rx) = oneshot::channel();
    if app.auth.try_send(Request::Verify(token, reply)).is_err() {
        let _ = send(&mut socket, reject("busy", "Authentication busy", None)).await;
        return;
    }
    let Ok(Ok(Some(identity))) = tokio::time::timeout(Duration::from_secs(10), rx).await else {
        let _ = send(
            &mut socket,
            reject("unauthenticated", "Invalid or expired session", None),
        )
        .await;
        return;
    };
    let id = identity.id.clone();
    let connection = auth::random_id();
    let (output, mut outgoing) = mpsc::channel(32);
    let (reply, rx) = oneshot::channel();
    if app
        .world
        .try_send(world::Command::Join {
            identity,
            connection: connection.clone(),
            output,
            reply,
            lang: lang.unwrap_or_default(),
        })
        .is_err()
    {
        let _ = send(&mut socket, reject("busy", "World queue full", None)).await;
        return;
    }
    match rx.await {
        Ok(true) => {}
        _ => {
            if let Some(msg) = outgoing.recv().await {
                let _ = send(&mut socket, msg).await;
            }
            return;
        }
    }
    let mut window = Instant::now();
    let mut count = 0;
    let mut last_received = Instant::now();
    let mut watchdog = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            packet=socket.recv()=>{
                if window.elapsed()>=Duration::from_secs(1) { window=Instant::now();count=0; } count+=1;
                if count>60 { let _=send(&mut socket,reject("rate_limit","Maximum 60 messages per second",None)).await;break; }
                match packet {
                    Some(Ok(Message::Text(text)))=>{
                        last_received=Instant::now();
                        let parsed=serde_json::from_str::<ClientMessage>(&text);
                        match parsed {
                            Ok(message) if message.valid() && !matches!(message,ClientMessage::Hello{..})=>{
                                if app.world.try_send(world::Command::Input{id:id.clone(),connection:connection.clone(),message}).is_err() { let _=send(&mut socket,reject("busy","World queue full; reconnect",None)).await;break; }
                            }
                            _=>{ if !send(&mut socket,reject("invalid_message","Unknown fields, type, or invalid values",None)).await { break; } }
                        }
                    }
                    Some(Ok(Message::Ping(_)))|Some(Ok(Message::Pong(_)))=>{},
                    _=>break,
                }
            }
            event=outgoing.recv()=>{ match event {Some(text)=>if !send(&mut socket,text).await {break;},None=>break} }
            _=watchdog.tick()=>{ if last_received.elapsed()>Duration::from_secs(30) {break;} }
        }
    }
    // Leave cannot be dropped when the input queue is full. Only this task owns this connection token.
    let _ = app
        .world
        .send(world::Command::Leave { id, connection })
        .await;
}
