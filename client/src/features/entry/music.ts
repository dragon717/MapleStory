import { resolveAssetUrl } from '../../assets/resource-url';

/** Entry music uses the same gesture-unlocked context that Phaser receives on entry. */
export class EntryMusic {
  onChange?: () => void;
  muted = false;
  private active = false;
  private bytes?: ArrayBuffer;
  private buffer?: AudioBuffer;
  private source?: AudioBufferSourceNode;
  private gain?: GainNode;
  private decoding = false;
  private url?: string;
  constructor(private context: () => AudioContext | undefined) {}
  setTrack(url: string) {
    if (this.url === url) return;
    this.stop(); this.url = url; this.bytes = undefined; this.buffer = undefined;
    void fetch(resolveAssetUrl(url)).then(r => { if (!r.ok) throw new Error('BGM unavailable'); return r.arrayBuffer(); })
      .then(bytes => { if (this.url === url) { this.bytes = bytes; this.resume(); } }).catch(() => { this.onChange?.(); });
  }
  setActive(active: boolean) { this.active = active; if (active) this.resume(); else this.stop(); }
  setMuted(muted: boolean) { this.muted = muted; if (this.gain) this.gain.gain.value = muted ? 0 : .25; this.resume(); this.onChange?.(); }
  get playing() { return Boolean(this.source && !this.muted && this.active && this.context()?.state === 'running'); }
  async resume() {
    const context = this.context(), url = this.url;
    if (!this.active || this.muted || document.hidden || !this.bytes || !context || context.state !== 'running' || this.source || this.decoding) return;
    this.decoding = true;
    try {
      const buffer = this.buffer ?? await context.decodeAudioData(this.bytes.slice(0));
      if (url !== this.url) return;
      this.buffer = buffer;
      if (!this.active || this.muted || document.hidden || context !== this.context() || context.state !== 'running') return;
      this.source = context.createBufferSource(); this.source.buffer = buffer; this.source.loop = true;
      this.gain = context.createGain(); this.gain.gain.value = .25;
      this.source.connect(this.gain); this.gain.connect(context.destination); this.source.start();
    } catch { /* A later trusted input can retry; the lobby remains usable without audio. */ }
    finally { this.decoding = false; this.onChange?.(); }
  }
  private stop() { this.source?.stop(); this.source?.disconnect(); this.gain?.disconnect(); this.source = undefined; this.gain = undefined; this.onChange?.(); }
  dispose() { this.active = false; this.stop(); this.url = undefined; this.bytes = undefined; this.buffer = undefined; this.onChange = undefined; }
}
