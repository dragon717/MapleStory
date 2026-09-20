import type { ColossusBody } from '../../../../shared/protocol';
import { resolveAssetUrl } from '../../assets/resource-url';
/** Presentation only: waves, carrier weight and already-authored rope/wood cues. */
export class HarborSound {
    private context?: AudioContext;
    private wash?: GainNode;
    private mute = false;
    private lastFoot = -1;
    private lastGiant = -1;
    private lastStoneS: number[] = [];
    private lastStoneStep: number[] = [];
    private lastStoneTrack: string[] = [];
    private lastStoneWarp: number[] = [];
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
    private stoneStep(body: ColossusBody | undefined, stones: ColossusBody[] | undefined) {
        if (!stones) {
            this.lastStoneS = [];
            this.lastStoneStep = [];
            this.lastStoneTrack = [];
            this.lastStoneWarp = [];
            return;
        }
        for (let i = 0; i < stones.length; i++) {
            const stone = stones[i];
            // The server keeps the fast small stone at index 0 and the slow large stone at index 1.
            const stride = i === 0 ? 3.5 : 5.5;
            const currentStep = Math.floor(stone.s / stride);
            const sameRun = this.lastStoneTrack[i] === stone.track && this.lastStoneWarp[i] === stone.warp;
            const previousS = this.lastStoneS[i];
            const previousStep = this.lastStoneStep[i];
            const moved = previousS !== undefined && Math.abs(stone.s - previousS) > .001;
            const crossed = previousStep !== undefined && currentStep !== previousStep;
            if (sameRun && body && stone.grounded && moved && crossed && Math.abs(stone.speed) > .15) {
                const dx = stone.position[0] - body.position[0];
                const dy = stone.position[1] - body.position[1];
                const dz = stone.position[2] - body.position[2];
                const distance = Math.hypot(dx, dy, dz);
                const distanceGain = Math.max(0, 1 - distance / 72);
                if (distanceGain > 0) {
                    const base = i === 0 ? .08 : .15;
                    this.cue('step_stone', base * distanceGain * distanceGain);
                }
            }
            this.lastStoneS[i] = stone.s;
            this.lastStoneStep[i] = currentStep;
            this.lastStoneTrack[i] = stone.track;
            this.lastStoneWarp[i] = stone.warp;
        }
        this.lastStoneS.length = stones.length;
        this.lastStoneStep.length = stones.length;
        this.lastStoneTrack.length = stones.length;
        this.lastStoneWarp.length = stones.length;
    }
    update(seconds: number, bridgeAge: number | null, body?: ColossusBody, stones?: ColossusBody[]) {
        if (this.context && this.wash && !this.mute && !document.hidden) {
            const rising = seconds > 30 && seconds < 65;
            this.wash.gain.setTargetAtTime((rising ? .08 : .027) * (1 + .25 * Math.sin(seconds * .55)), this.context.currentTime, .3);
            const beat = seconds >= 30 && seconds < 65 ? Math.floor((seconds - 30) / 4.5) : -1;
            if (beat >= 0 && this.lastGiant !== beat) {
                const c = this.context, o = c.createOscillator(), g = c.createGain();
                o.frequency.setValueAtTime(36, c.currentTime);
                o.frequency.exponentialRampToValueAtTime(22, c.currentTime + .8);
                g.gain.setValueAtTime(.0001, c.currentTime);
                g.gain.exponentialRampToValueAtTime(.13, c.currentTime + .025);
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
        const step = Math.floor(performance.now() * .0028);
        if (body?.grounded && Math.abs(body.speed) > .5 && step !== this.lastFoot)
            this.cue(['harbor', 'lower', 'quay'].includes(body.track) ? 'step_wood' : 'step_stone', .12);
        this.lastFoot = step;
        this.stoneStep(body, stones);
    }
    destroy() { window.removeEventListener('keydown', this.unlock); window.removeEventListener('pointerdown', this.unlock); document.removeEventListener('visibilitychange', this.visibility); for (const a of this.cues.values()) {
        a.pause();
        a.removeAttribute('src');
        a.load();
    } void this.context?.close(); }
}
