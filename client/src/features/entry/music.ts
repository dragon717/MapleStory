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
  private decode?: Promise<AudioBuffer>;
  private loading?: Promise<void>;
  private failed = false;
  private generation = 0;
  private url?: string;
  constructor(private context: () => AudioContext | undefined, private wake?: () => void) {}
  setTrack(url: string): Promise<void> {
    if (this.url === url) return this.loading ?? Promise.resolve();
    this.stop(); this.url = url; this.bytes = undefined; this.buffer = undefined; this.decode = undefined; this.failed = false;
    const generation = ++this.generation;
    return this.loading = fetch(resolveAssetUrl(url), { priority: 'high', signal: AbortSignal.timeout(15000) })
      .then(r => { if (!r.ok) throw new Error('BGM unavailable'); return r.arrayBuffer(); })
      .then(async bytes => { if (generation === this.generation) { this.bytes = bytes; await this.resume(); } })
      .catch(() => { if (generation === this.generation) { this.failed = true; this.onChange?.(); } });
  }
  setActive(active: boolean) { this.active = active; if (active) { this.wake?.(); void this.resume(); } else this.stop(); }
  setMuted(muted: boolean) { this.muted = muted; if (this.gain) this.gain.gain.value = muted ? 0 : .25; void this.resume(); this.onChange?.(); }
  get isActive() { return this.active; }
  get playing() { return Boolean(this.source && !this.muted && this.active && this.context()?.state === 'running'); }
  /** Muted/unsupported/failed audio must not prevent access to the lobby. */
  get openingReady() { return this.playing || this.muted || this.failed || !this.context() || this.context()?.state === 'closed'; }
  get needsGesture() { return !this.muted && !this.failed && this.context()?.state === 'suspended'; }
  begin() { this.wake?.(); void this.resume(); }
  async resume() {
    const context = this.context(), generation = this.generation;
    if (!this.active || !this.bytes || !context || context.state === 'closed' || this.source) return;
    // Prepare audio before the ship reveal even when autoplay is suspended. A trusted
    // gesture then starts a prepared buffer, rather than beginning its download.
    let decode = this.decode;
    try {
      if (!decode) {
        decode = this.decode = this.buffer ? Promise.resolve(this.buffer) : new Promise<AudioBuffer>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('BGM decoding timed out')), 5000);
          try { context.decodeAudioData(this.bytes!.slice(0)).then(resolve, reject).finally(() => clearTimeout(timer)); }
          catch (error) { clearTimeout(timer); reject(error); }
        });
      }
      const buffer = await decode;
      if (generation !== this.generation) return;
      this.buffer = buffer;
      if (!this.active || this.muted || document.hidden || context !== this.context() || context.state !== 'running' || this.source) return;
      this.source = context.createBufferSource(); this.source.buffer = buffer; this.source.loop = true;
      this.gain = context.createGain(); this.gain.gain.value = .25;
      this.source.connect(this.gain); this.gain.connect(context.destination); this.source.start();
    } catch { if (generation === this.generation) this.failed = true; }
    finally { if (generation === this.generation) { if (this.decode === decode) this.decode = undefined; this.onChange?.(); } }
  }
  private stop() { this.source?.stop(); this.source?.disconnect(); this.gain?.disconnect(); this.source = undefined; this.gain = undefined; this.onChange?.(); }
  dispose() { this.generation++; this.active = false; this.stop(); this.url = undefined; this.bytes = undefined; this.buffer = undefined; this.decode = undefined; this.onChange = undefined; }
}
