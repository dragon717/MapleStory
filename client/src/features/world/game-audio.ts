import Phaser from 'phaser';
import { EntryMusic } from '../entry/music';
/** Keep the login gesture's context through asynchronous loading. The 3D overlay
 * cancels compatibility mouse events, so recovery uses trusted input in capture. */
export function installGameAudio(host:HTMLElement,getGame:()=>Phaser.Game|undefined){
  let prepared:AudioContext|undefined;
  let wasRunning=false;
  const wake=()=>{
    const sound=getGame()?.sound;
    const context=sound instanceof Phaser.Sound.WebAudioSoundManager?sound.context:prepared;
    if(document.hidden||!context||context.state!=='suspended')return;
    void context.resume().then(()=>{void entry.resume();entry.onChange?.();}).catch(()=>{});
  };
  const changed=()=>{
    if(prepared?.state==='running'){wasRunning=true;void entry.resume();entry.onChange?.();}
    // Phaser destroys an externally supplied context by suspending it on the
    // next frame. Recover even when the lobby has already restarted its music.
    else if(wasRunning&&entry.isActive)wake();
  };
  const prepare=(Audio:typeof AudioContext)=>{
    prepared?.removeEventListener('statechange',changed);
    prepared=new Audio(); wasRunning=prepared.state==='running';
    prepared.addEventListener('statechange',changed);
    return prepared;
  };
  const entry = new EntryMusic(() => {
    const sound = getGame()?.sound;
    return sound instanceof Phaser.Sound.WebAudioSoundManager ? sound.context : prepared;
  },wake);
  const unlock=(event:Event)=>{
    if(!event.isTrusted)return;
    const sound=getGame()?.sound;
    const manager=sound instanceof Phaser.Sound.WebAudioSoundManager?sound:undefined;
    let context=manager?.context??prepared;
    if(!context||context.state==='closed'){
      if(!(event.target instanceof Node)||!host.contains(event.target))return;
      const Audio=window.AudioContext??(window as unknown as {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!Audio)return;
      context=prepare(Audio);
    }
    if(context.state==='running'){if(manager?.locked)(manager as Phaser.Sound.WebAudioSoundManager & {unlocked:boolean}).unlocked=true;void entry.resume();return;}
    // Do not unregister on rejection: a later real click/key must be able to recover.
    void context.resume().then(()=>{
      if(manager?.context===context&&context.state==='running'&&manager.locked)(manager as Phaser.Sound.WebAudioSoundManager & {unlocked:boolean}).unlocked=true;
      void entry.resume();
    }).catch(()=>{});
  };
  const visibility=()=>{
    const sound=getGame()?.sound;
    // Phaser retries resume each frame unless this flag agrees with page visibility.
    if(sound instanceof Phaser.Sound.WebAudioSoundManager)sound.gameLostFocus=document.hidden;
    const context=sound instanceof Phaser.Sound.WebAudioSoundManager?sound.context:prepared;
    if(!context||context.state==='closed')return;
    // Window blur also happens while the game is visible (Safari inspector/app panels).
    // Pause only when the document is hidden; trusted input still unlocks first playback.
    void (document.hidden?context.suspend():context.resume()).then(()=>{void entry.resume();entry.onChange?.();}).catch(()=>{});
  };
  // Try autoplay immediately; browsers that require input keep this context
  // suspended and the capture listener above resumes the same context later.
  const Audio=window.AudioContext??(window as unknown as {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
  if(Audio){
    try { prepare(Audio); void prepared!.resume().then(()=>{void entry.resume();entry.onChange?.();}).catch(()=>{}); }
    catch { /* Audio is optional on unsupported devices. */ }
  }
  document.addEventListener('visibilitychange',visibility);
  for(const event of ['pointerdown','pointerup','keydown'])window.addEventListener(event,unlock,true);
  return {entry,context:()=>prepared,bind(game:Phaser.Game){
    game.sound.pauseOnBlur=false;
    if(game.sound instanceof Phaser.Sound.WebAudioSoundManager){
      // Phaser's delayed visible handler can resume a tab that was hidden again.
      const manager=game.sound as Phaser.Sound.WebAudioSoundManager & {onGameVisible:()=>void};
      game.events.off(Phaser.Core.Events.VISIBLE,manager.onGameVisible,manager);
    }
    if(document.hidden)visibility();
  },dispose(){entry.dispose();prepared?.removeEventListener('statechange',changed);document.removeEventListener('visibilitychange',visibility);for(const event of ['pointerdown','pointerup','keydown'])window.removeEventListener(event,unlock,true);}};
}
