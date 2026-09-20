import type { ColossusBody } from '../../../../shared/protocol';
import { resolveAssetUrl } from '../../assets/resource-url';
/** Presentation only: waves, carrier weight and already-authored rope/wood cues. */
export class HarborSound {
    private context?: AudioContext;
    private wash?: GainNode;
    private mute = false;
    private lastFoot = -1;
    private lastGiant = -1;
    private bridgeAge: number | null | undefined;
    private cues = new Map<string, HTMLAudioElement>();
    constructor() { window.addEventListener('keydown', this.unlock); window.addEventListener('pointerdown', this.unlock); document.addEventListener('visibilitychange', this.visibility); }
    private unlock = () => {
        if (!this.context) {
            const c = this.context = new AudioContext();
            const buffer = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++)
                data[i] = Math.random() * 2 - 1;
            const source = c.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            const filter = c.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 850;
            this.wash = c.createGain();
            this.wash.gain.value = 0;
            source.connect(filter).connect(this.wash).connect(c.destination);
            source.start();
        }
        if (!this.mute && !document.hidden)
            void this.context.resume().catch(() => { });
    };
    private visibility = () => { if (document.hidden) {
        void this.context?.suspend();
        for (const a of this.cues.values())
            a.pause();
    }
    else if (!this.mute)
        void this.context?.resume().catch(() => { }); };
    setMuted(muted: boolean) { this.mute = muted; for (const a of this.cues.values())
        a.muted = muted; if (muted)
        void this.context?.suspend();
    else
        this.unlock(); }
    private cue(name: string, volume: number) { if (this.mute || document.hidden)
        return; let a = this.cues.get(name); if (!a) {
        a = new Audio(resolveAssetUrl(`/assets/windbell/sfx/${name}.ogg`));
        this.cues.set(name, a);
    } a.volume = volume; a.currentTime = 0; void a.play().catch(() => { }); }
    update(seconds: number, bridgeAge: number | null, body?: ColossusBody) {
        if (this.context && this.wash && !this.mute && !document.hidden) {
            const rising = seconds > 30 && seconds < 65;
            this.wash.gain.setTargetAtTime((rising ? .08 : .027) * (1 + .25 * Math.sin(seconds * .55)), this.context.currentTime, .3);
            const beat = Math.floor(seconds / (seconds < 30 ? 3.1 : 4.5));
            if (this.lastGiant !== beat && seconds > 3 && seconds < 72) {
                const c = this.context, o = c.createOscillator(), g = c.createGain();
                o.frequency.setValueAtTime(seconds < 30 ? 65 : 36, c.currentTime);
                o.frequency.exponentialRampToValueAtTime(22, c.currentTime + .8);
                g.gain.setValueAtTime(.0001, c.currentTime);
                g.gain.exponentialRampToValueAtTime(seconds < 30 ? .04 : .13, c.currentTime + .025);
                g.gain.exponentialRampToValueAtTime(.0001, c.currentTime + .9);
                o.connect(g).connect(c.destination);
                o.start();
                o.stop(c.currentTime + 1);
                o.onended = () => { o.disconnect(); g.disconnect(); };
            }
            this.lastGiant = beat;
        }
        if (this.bridgeAge === null && bridgeAge !== null)
            this.cue('rope_sever', .32);
        if (this.bridgeAge !== undefined && this.bridgeAge !== null && this.bridgeAge < 1.5 && bridgeAge !== null && bridgeAge >= 1.5)
            this.cue('bridge_land', .45);
        this.bridgeAge = bridgeAge;
        const step = Math.floor(seconds * 2.8);
        if (body?.grounded && Math.abs(body.speed) > .5 && step !== this.lastFoot)
            this.cue(['harbor', 'lower', 'quay'].includes(body.track) ? 'step_wood' : 'step_stone', .12);
        this.lastFoot = step;
    }
    destroy() { window.removeEventListener('keydown', this.unlock); window.removeEventListener('pointerdown', this.unlock); document.removeEventListener('visibilitychange', this.visibility); for (const a of this.cues.values()) {
        a.pause();
        a.removeAttribute('src');
        a.load();
    } void this.context?.close(); }
}
