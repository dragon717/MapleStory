use super::*;

async fn login(auth: &AuthService, username: &str) -> (Identity, String) {
    let (reply, rx) = oneshot::channel();
    auth.sender
        .send(Request::Login(
            Credentials {
                username: username.into(),
                password: "synthetic-password".into(),
            },
            reply,
        ))
        .await
        .unwrap();
    rx.await.unwrap().unwrap()
}
async fn lobby(
    auth: &AuthService,
    token: &str,
    action: lobby::Action,
) -> Result<lobby::Response, String> {
    let (reply, rx) = oneshot::channel();
    auth.sender
        .send(Request::Lobby {
            token: token.into(),
            action,
            reply,
        })
        .await
        .unwrap();
    rx.await.unwrap()
}
async fn authorize(auth: &AuthService, token: &str) -> Option<Authorization> {
    let (reply, rx) = oneshot::channel();
    auth.sender
        .send(Request::AuthorizeCharacter(token.into(), reply))
        .await
        .unwrap();
    rx.await.unwrap()
}
async fn role(auth: &AuthService, account: &str, name: &str) -> String {
    let response = lobby(
        auth,
        account,
        lobby::Action::Create {
            request_id: format!("create-{name}"),
            name: name.into(),
            appearance: lobby::Appearance {
                gender: 0,
                face: 20100,
                hair: 30000,
                skin: 0,
                coat: 1050286,
                pants: 0,
                shoes: 1072833,
                weapon: 1302000,
            },
        },
    )
    .await
    .unwrap();
    let lobby::Response::Created { character } = response else {
        panic!("expected creation");
    };
    character.id
}
async fn select(auth: &AuthService, account: &str, role: &str) -> String {
    let response = lobby(
        auth,
        account,
        lobby::Action::Select {
            character_id: role.into(),
            channel_id: Some(1),
        },
    )
    .await
    .unwrap();
    let lobby::Response::Selected {
        token: Some(token), ..
    } = response
    else {
        panic!("expected selection");
    };
    token
}
#[tokio::test]
async fn session_revocation_selection_logout_and_trusted_gm_source() {
    let path = std::env::temp_dir().join(format!("maple-session-{}.sqlite3", random_id()));
    let auth = start_with_gm_accounts(&path, HashSet::from(["trusted-admin-id".into()])).unwrap();
    let hash = Argon2::default()
        .hash_password(b"synthetic-password", &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    auth.store
        .with_db(|db| {
            db.execute(
                "INSERT INTO accounts(id,username,password_hash) VALUES (?1,?2,?3)",
                params!["trusted-admin-id", "admin_fixture", hash],
            )
            .map(|_| ())
            .map_err(|_| "fixture".into())
        })
        .unwrap();
    let (reply, rx) = oneshot::channel();
    auth.sender
        .send(Request::Register(
            Credentials {
                username: "user_fixture".into(),
                password: "synthetic-password".into(),
            },
            reply,
        ))
        .await
        .unwrap();
    rx.await.unwrap().unwrap();
    let (_, first_account) = login(&auth, "user_fixture").await;
    assert!(
        authorize(&auth, &first_account).await.is_none(),
        "account token cannot bind a new account directly"
    );
    let first_role = role(&auth, &first_account, "UserOne").await;
    let second_role = role(&auth, &first_account, "UserTwo").await;
    let first_token = select(&auth, &first_account, &first_role).await;
    let first_grant = authorize(&auth, &first_token).await.unwrap();
    assert!(!first_grant.gm, "registration/first role does not grant GM");
    let (_, new_account) = login(&auth, "user_fixture").await;
    assert!(
        !first_grant.lease.valid(),
        "reauth revokes an already-issued/inflight lease"
    );
    assert!(authorize(&auth, &first_token).await.is_none());
    assert!(lobby(
        &auth,
        &first_account,
        lobby::Action::List { channel_id: None }
    )
    .await
    .is_err());
    let second_token = select(&auth, &new_account, &second_role).await;
    let second_grant = authorize(&auth, &second_token).await.unwrap();
    let next_token = select(&auth, &new_account, &first_role).await;
    assert!(
        !second_grant.lease.valid(),
        "selection revokes the previous role controller"
    );
    assert!(authorize(&auth, &second_token).await.is_none());
    let next_grant = authorize(&auth, &next_token).await.unwrap();
    next_grant.lease.revoke(); // World invokes this on explicit role logout.
    assert!(authorize(&auth, &next_token).await.is_none());
    assert!(
        lobby(
            &auth,
            &new_account,
            lobby::Action::List { channel_id: None }
        )
        .await
        .is_ok(),
        "role logout preserves account selection rights"
    );
    let active_token = select(&auth, &new_account, &second_role).await;
    let active = authorize(&auth, &active_token).await.unwrap();
    assert!(matches!(
        lobby(&auth, &new_account, lobby::Action::Logout)
            .await
            .unwrap(),
        lobby::Response::LoggedOut
    ));
    assert!(!active.lease.valid());
    assert!(authorize(&auth, &active_token).await.is_none());
    assert!(lobby(
        &auth,
        &new_account,
        lobby::Action::List { channel_id: None }
    )
    .await
    .is_err());
    let (_, admin_account) = login(&auth, "admin_fixture").await;
    assert!(
        lobby(
            &auth,
            &admin_account,
            lobby::Action::Select {
                character_id: first_role,
                channel_id: None
            }
        )
        .await
        .is_err(),
        "trusted admin still cannot select another account's role"
    );
    let admin_role = role(&auth, &admin_account, "AdminOne").await;
    let admin_token = select(&auth, &admin_account, &admin_role).await;
    assert!(
        authorize(&auth, &admin_token).await.unwrap().gm,
        "only configured stable account id grants GM"
    );
    drop(auth);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn pruning_expired_account_revokes_its_legacy_control_lease() {
    let control = Arc::new(SessionLease::new(Instant::now() + Duration::from_secs(60)));
    let session = Session {
        token: "synthetic-token".into(),
        identity: Identity {
            id: "account".into(),
            username: "fixture".into(),
        },
        account_id: "account".into(),
        kind: SessionKind::Account,
        lease: Arc::new(SessionLease::new(Instant::now())),
        control_lease: control.clone(),
    };
    let mut sessions = HashMap::from([("account".into(), session)]);
    prune_sessions(&mut sessions);
    assert!(sessions.is_empty());
    assert!(!control.valid());
}
