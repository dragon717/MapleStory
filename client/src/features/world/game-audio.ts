import Phaser from 'phaser';
/** Keep the login gesture's context through asynchronous loading. The 3D overlay
 * cancels compatibility mouse events, so recovery uses trusted input in capture. */
export function installGameAudio(host:HTMLElement,getGame:()=>Phaser.Game|undefined){
  let prepared:AudioContext|undefined;
  const unlock=(event:Event)=>{
    if(!event.isTrusted)return;
    const sound=getGame()?.sound;
    const manager=sound instanceof Phaser.Sound.WebAudioSoundManager?sound:undefined;
    let context=manager?.context??prepared;
    if(!context||context.state==='closed'){
      if(!(event.target instanceof Node)||!host.contains(event.target))return;
      const Audio=window.AudioContext??(window as unknown as {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!Audio)return;
      context=prepared=new Audio();
    }
    if(context.state==='running'){if(manager?.locked)(manager as Phaser.Sound.WebAudioSoundManager & {unlocked:boolean}).unlocked=true;return;}
    // Do not unregister on rejection: a later real click/key must be able to recover.
    void context.resume().then(()=>{
      if(manager?.context===context&&context.state==='running'&&manager.locked)(manager as Phaser.Sound.WebAudioSoundManager & {unlocked:boolean}).unlocked=true;
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
    void (document.hidden?context.suspend():context.resume()).catch(()=>{});
  };
  document.addEventListener('visibilitychange',visibility);
  for(const event of ['pointerdown','pointerup','keydown'])window.addEventListener(event,unlock,true);
  return {context:()=>prepared,bind(game:Phaser.Game){
    game.sound.pauseOnBlur=false;
    if(game.sound instanceof Phaser.Sound.WebAudioSoundManager){
      // Phaser's delayed visible handler can resume a tab that was hidden again.
      const manager=game.sound as Phaser.Sound.WebAudioSoundManager & {onGameVisible:()=>void};
      game.events.off(Phaser.Core.Events.VISIBLE,manager.onGameVisible,manager);
    }
    if(document.hidden)visibility();
  },dispose(){document.removeEventListener('visibilitychange',visibility);for(const event of ['pointerdown','pointerup','keydown'])window.removeEventListener(event,unlock,true);}};
}
