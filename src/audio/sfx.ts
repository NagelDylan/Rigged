// RIGGED — procedural WebAudio sound design. No samples: oscillators + one shared
// noise buffer, enveloped and filtered. Everything routes through
//   voices -> fx/loop bus -> master gain -> compressor -> soft clipper -> out.
// All public methods are no-ops before unlock() or while muted.
import type { Ability } from "../shared/rig";

type Ctx = BaseAudioContext;
type Wave = OscillatorType;
type FType = BiquadFilterType;

const MUTE_KEY = "rigged.muted";
const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const semi = (n: number) => Math.pow(2, n / 12);
const TINY = 0.0001;

interface ToneOpts { type?: Wave; f: number; f2?: number; glide?: number; t: number; dur: number; a?: number; peak: number; dest?: AudioNode; detune?: number; lp?: number; pan?: number }
interface NoiseOpts { t: number; dur: number; a?: number; peak: number; ft?: FType; f: number; f2?: number; q?: number; dest?: AudioNode; pan?: number; rate?: number }

/** Smoothed continuous param: only schedules when the target moved meaningfully. */
class Smooth {
  private last = NaN;
  constructor(private p: AudioParam, private tc = 0.05) {}
  reset() { this.last = NaN; }
  set(ctx: Ctx, v: number, eps = 0.002) {
    if (Math.abs(v - this.last) < eps) return;
    this.last = v;
    this.p.setTargetAtTime(v, ctx.currentTime, this.tc);
  }
}

interface MotorVoice { f1: Smooth; f2: Smooth; lp: Smooth; g: Smooth; grit: Smooth; gf: Smooth; oscs: OscillatorNode[] }

export class Sfx {
  private ctx: Ctx | null = null;
  private injected: Ctx | null;
  private master!: GainNode;
  private fx!: GainNode;
  private loop!: GainNode;
  private noiseBuf!: AudioBuffer;
  private _muted = false;
  private volume = 0.55;
  private gates = new Map<string, number>();
  private frozenUntil = 0;
  private motorV: MotorVoice[] | null = null;
  private rollV: { g: Smooth; bp: Smooth; lfo: Smooth; depth: Smooth } | null = null;
  private humV: { g: Smooth; pulse: Smooth; depth: Smooth; nodes: AudioScheduledSourceNode[] } | null = null;
  private strainV: { g: Smooth } | null = null;

  constructor(ctx?: Ctx) {
    this.injected = ctx ?? null;
    try { this._muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------- setup
  unlock(): void {
    try {
      if (!this.ctx) {
        if (this.injected) this.ctx = this.injected;
        else {
          const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!AC) return;
          this.ctx = new AC();
        }
        this.build(this.ctx);
      }
      const c = this.ctx as AudioContext;
      if ("close" in c && c.state === "suspended") void c.resume().catch(() => {});
    } catch { this.ctx = null; }
  }

  private build(ctx: Ctx) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.18;
    // Soft clipper after the compressor catches its attack overshoot.
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) { const x = (i / 512) - 1; curve[i] = 0.97 * Math.tanh(x * 1.2) / Math.tanh(1.2); }
    clip.curve = curve;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : this.volume;
    this.fx = ctx.createGain(); this.fx.gain.value = 0.85;
    this.loop = ctx.createGain(); this.loop.gain.value = 0.8;
    this.fx.connect(this.master); this.loop.connect(this.master);
    this.master.connect(comp); comp.connect(clip); clip.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  get muted(): boolean { return this._muted; }
  setMuted(m: boolean): void {
    this._muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }
  setMasterVolume(v: number): void {
    this.volume = clamp(v);
    if (this.ctx && !this._muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
  }

  // ---------------------------------------------------------------- primitives
  /** Returns ctx + a start time if sound may play (and the per-key gate is open). */
  private go(key?: string, minMs = 0): { c: Ctx; t: number } | null {
    const c = this.ctx;
    if (!c || this._muted) return null;
    if (key) {
      const now = c.currentTime * 1000, last = this.gates.get(key);
      if (last !== undefined && now - last < minMs) return null;
      this.gates.set(key, now);
    }
    return { c, t: c.currentTime + 0.01 };
  }

  private out(c: Ctx, dest: AudioNode | undefined, pan: number | undefined): AudioNode {
    const d = dest ?? this.fx;
    if (pan === undefined || !c.createStereoPanner) return d;
    const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(d);
    return p;
  }

  private env(g: AudioParam, t: number, a: number, peak: number, dur: number) {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + a);
    g.exponentialRampToValueAtTime(TINY, t + Math.max(dur, a + 0.005));
  }

  private tone(o: ToneOpts): OscillatorNode {
    const c = this.ctx!;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.f, o.t);
    if (o.f2 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), o.t + (o.glide ?? o.dur));
    if (o.detune) osc.detune.value = o.detune;
    this.env(g.gain, o.t, o.a ?? 0.004, o.peak, o.dur);
    let node: AudioNode = osc;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.lp; osc.connect(f); node = f; }
    node.connect(g); g.connect(this.out(c, o.dest, o.pan));
    osc.start(o.t); osc.stop(o.t + o.dur + 0.05);
    return osc;
  }

  private noise(o: NoiseOpts): { src: AudioBufferSourceNode; g: GainNode; f: BiquadFilterNode } {
    const c = this.ctx!;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf;
    if (o.rate) src.playbackRate.value = o.rate;
    const f = c.createBiquadFilter(); f.type = o.ft ?? "bandpass"; f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.f, o.t);
    if (o.f2 !== undefined) f.frequency.exponentialRampToValueAtTime(o.f2, o.t + o.dur);
    const g = c.createGain();
    this.env(g.gain, o.t, o.a ?? 0.002, o.peak, o.dur);
    src.connect(f); f.connect(g); g.connect(this.out(c, o.dest, o.pan));
    src.start(o.t, Math.random() * 1.5); src.stop(o.t + o.dur + 0.05);
    return { src, g, f };
  }

  private loopNoise(c: Ctx): AudioBufferSourceNode {
    const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    s.start(c.currentTime, Math.random() * 1.5);
    return s;
  }

  /** Inharmonic metal hit: noise transient + a few decaying partials. */
  private clank(t: number, size = 1, peak = 0.3, pan?: number) {
    const base = rnd(300, 360) / size;
    this.noise({ t, dur: 0.06, peak: peak * 0.9, ft: "bandpass", f: 1400 / size, q: 0.9, pan });
    this.tone({ t, f: 140 / size, f2: 60 / size, dur: 0.18, peak: peak * 0.8, pan });
    [1, 1.52, 2.31, 3.17].forEach((r, i) =>
      this.tone({ t, f: base * r * rnd(0.98, 1.02), dur: 0.35 - i * 0.06, peak: peak * 0.22 / (i + 1), type: "triangle", pan }));
  }

  /** Relay click: tight high transient + tiny thunk. */
  private relay(t: number, peak = 0.25) {
    this.noise({ t, dur: 0.018, peak, ft: "highpass", f: 3500, q: 0.7 });
    this.tone({ t, type: "square", f: 2100, f2: 900, dur: 0.012, peak: peak * 0.3 });
    this.tone({ t: t + 0.004, f: 180, f2: 90, dur: 0.05, peak: peak * 0.7 });
  }

  // ---------------------------------------------------------------- continuous
  motors(vL: number, vR: number, maxSpeed: number): void {
    const c = this.ctx;
    if (!c || this._muted || c.currentTime < this.frozenUntil) return;
    if (!this.motorV) this.motorV = [-0.65, 0.65].map((pan, i) => this.makeMotor(c, pan, i ? 1.035 : 1));
    const m = maxSpeed > 0 ? maxSpeed : 1;
    [vL, vR].forEach((v, i) => {
      const mv = this.motorV![i], s = clamp(Math.abs(v) / m), k = i ? 1.035 : 1;
      const f = (42 + 150 * s) * k;
      mv.f1.set(c, f, 0.3); mv.f2.set(c, f * 2.005, 0.3);
      mv.lp.set(c, 260 + 1500 * s, 5);
      mv.g.set(c, s < 0.02 ? 0 : 0.025 + 0.05 * s);
      mv.grit.set(c, s < 0.02 ? 0 : 0.012 + 0.03 * s);
      mv.gf.set(c, 900 + 2600 * s, 10);
    });
  }

  private makeMotor(c: Ctx, pan: number, k: number): MotorVoice {
    const o1 = c.createOscillator(), o2 = c.createOscillator();
    o1.type = "sawtooth"; o2.type = "square";
    o1.frequency.value = 42 * k; o2.frequency.value = 84 * k; o2.detune.value = 7;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 3; lp.frequency.value = 260;
    const mix = c.createGain(); mix.gain.value = 0.6;
    const g = c.createGain(); g.gain.value = 0;
    const out = this.out(c, this.loop, pan);
    o1.connect(lp); o2.connect(mix); mix.connect(lp); lp.connect(g); g.connect(out);
    // Brush grit: bandpassed noise riding the motor.
    const n = this.loopNoise(c), bp = c.createBiquadFilter(), gg = c.createGain();
    bp.type = "bandpass"; bp.Q.value = 2.5; bp.frequency.value = 900; gg.gain.value = 0;
    n.connect(bp); bp.connect(gg); gg.connect(out);
    o1.start(); o2.start();
    return { f1: new Smooth(o1.frequency), f2: new Smooth(o2.frequency), lp: new Smooth(lp.frequency), g: new Smooth(g.gain, 0.06), grit: new Smooth(gg.gain, 0.06), gf: new Smooth(bp.frequency), oscs: [o1, o2] };
  }

  roll(speed: number, onBar: boolean): void {
    const c = this.ctx;
    if (!c || this._muted || c.currentTime < this.frozenUntil) return;
    if (!this.rollV) {
      const n = this.loopNoise(c), bp = c.createBiquadFilter(), am = c.createGain(), g = c.createGain();
      bp.type = "bandpass"; bp.Q.value = 0.9; bp.frequency.value = 300;
      am.gain.value = 0.6;
      const lfo = c.createOscillator(), depth = c.createGain(); lfo.type = "triangle"; lfo.frequency.value = 6; depth.gain.value = 0.4;
      lfo.connect(depth); depth.connect(am.gain);
      g.gain.value = 0;
      n.connect(bp); bp.connect(am); am.connect(g); g.connect(this.loop); lfo.start();
      this.rollV = { g: new Smooth(g.gain, 0.04), bp: new Smooth(bp.frequency), lfo: new Smooth(lfo.frequency), depth: new Smooth(depth.gain) };
    }
    const s = clamp(speed), r = this.rollV;
    r.g.set(c, s < 0.01 ? 0 : (onBar ? 0.22 : 0.12) * Math.sqrt(s));
    r.bp.set(c, (onBar ? 380 : 180) + (onBar ? 1400 : 600) * s, 8);
    r.lfo.set(c, 5 + 38 * s, 0.3);
    r.depth.set(c, onBar ? 0.45 : 0.25);
  }

  hum(on: boolean, intensity: number): void {
    const c = this.ctx;
    if (!c || this._muted || c.currentTime < this.frozenUntil) return;
    if (!this.humV) {
      const g = c.createGain(); g.gain.value = 0; g.connect(this.loop);
      const mains = c.createOscillator(); mains.frequency.value = 50;
      const h2 = c.createOscillator(); h2.type = "sawtooth"; h2.frequency.value = 100;
      const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 320;
      const gm = c.createGain(); gm.gain.value = 0.5; const gh = c.createGain(); gh.gain.value = 0.18;
      mains.connect(gm); gm.connect(g); h2.connect(lp); lp.connect(gh); gh.connect(g);
      const fan = this.loopNoise(c), flp = c.createBiquadFilter(), gf = c.createGain();
      flp.type = "lowpass"; flp.frequency.value = 700; gf.gain.value = 0.45;
      fan.connect(flp); flp.connect(gf); gf.connect(g);
      // Ominous pulse: 41 Hz sine, gain = base + LFO*depth (heartbeat at ~1.1 Hz).
      const po = c.createOscillator(); po.frequency.value = 41;
      const po2 = c.createOscillator(); po2.type = "triangle"; po2.frequency.value = 82.4;
      const pg = c.createGain(); pg.gain.value = 0;
      const lfo = c.createOscillator(); lfo.frequency.value = 1.1;
      const depth = c.createGain(); depth.gain.value = 0;
      const g2 = c.createGain(); g2.gain.value = 0.25;
      lfo.connect(depth); depth.connect(pg.gain);
      po.connect(pg); po2.connect(g2); g2.connect(pg); pg.connect(this.loop);
      const nodes = [mains, h2, fan, po, po2, lfo];
      nodes.forEach((n) => { if (n !== fan) n.start(); });
      this.humV = { g: new Smooth(g.gain, 0.4), pulse: new Smooth(pg.gain, 0.5), depth: new Smooth(depth.gain, 0.5), nodes };
    }
    const k = clamp(intensity);
    this.humV.g.set(c, on ? 0.035 : 0);
    this.humV.pulse.set(c, on ? 0.09 * k : 0, 0.004);
    this.humV.depth.set(c, on ? 0.09 * k : 0, 0.004);
  }

  strain(sideActive: boolean): void {
    const c = this.ctx;
    if (!c || this._muted || c.currentTime < this.frozenUntil) return;
    if (!this.strainV) {
      const a = c.createOscillator(), b = c.createOscillator();
      a.type = b.type = "sawtooth"; a.frequency.value = 61; b.frequency.value = 63.3;
      const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 7; lp.frequency.value = 300;
      const lfo = c.createOscillator(), dep = c.createGain(); lfo.frequency.value = 6.5; dep.gain.value = 140;
      lfo.connect(dep); dep.connect(lp.frequency);
      const g = c.createGain(); g.gain.value = 0;
      a.connect(lp); b.connect(lp); lp.connect(g); g.connect(this.loop);
      a.start(); b.start(); lfo.start();
      this.strainV = { g: new Smooth(g.gain, 0.08) };
    }
    this.strainV.g.set(c, sideActive ? 0.045 : 0);
  }

  // ---------------------------------------------------------------- one-shots
  /** speed normalised 0..1 (clamped). */
  wallClack(speed: number): void {
    const s = this.go("clack", 60); if (!s) return;
    const v = clamp(speed, 0.15, 1), t = s.t, pk = 0.12 + 0.28 * v;
    this.noise({ t, dur: 0.035, peak: pk, ft: "highpass", f: 1800, q: 0.7 });
    this.tone({ t, type: "triangle", f: rnd(820, 980), f2: 260, dur: 0.05, peak: pk * 0.7 });
    [1230, 1870, 2690].forEach((f, i) => this.tone({ t, f: f * rnd(0.97, 1.03), dur: 0.14 - i * 0.03, peak: pk * 0.18 }));
  }

  lipRattle(): void {
    const s = this.go("lip", 140); if (!s) return;
    let t = s.t;
    const n = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const pk = 0.13 * (1 - i / (n + 1));
      this.noise({ t, dur: 0.02, peak: pk, ft: "bandpass", f: rnd(2600, 3600), q: 3 });
      this.tone({ t, type: "triangle", f: rnd(1500, 2100), dur: 0.04, peak: pk * 0.4 });
      t += rnd(0.022, 0.045);
    }
  }

  death(): void {
    const s = this.go("death", 250); if (!s) return;
    const t = s.t;
    // Heavy clunk: trapdoor + body thump.
    this.tone({ t, f: 120, f2: 38, glide: 0.22, dur: 0.3, peak: 0.6 });
    this.noise({ t, dur: 0.12, peak: 0.35, ft: "lowpass", f: 600, q: 0.7 });
    this.clank(t + 0.01, 1.3, 0.22);
    // Ball rattles down the chute: accelerating ticks, falling pitch, fading.
    let tt = t + 0.12, gap = 0.07;
    for (let i = 0; i < 8; i++) {
      const pk = 0.16 * (1 - i / 10), f = 2400 * Math.pow(0.88, i) * rnd(0.92, 1.08);
      this.noise({ t: tt, dur: 0.025, peak: pk, ft: "bandpass", f, q: 4, pan: rnd(-0.25, 0.25) });
      this.tone({ t: tt, type: "triangle", f: f * 0.5, dur: 0.05, peak: pk * 0.35 });
      tt += gap; gap *= 0.84;
    }
    this.tone({ t: t + 0.52, f: 90, f2: 50, dur: 0.12, peak: 0.25 });
    this.noise({ t: t + 0.52, dur: 0.06, peak: 0.12, ft: "lowpass", f: 400 });
  }

  respawn(): void {
    const s = this.go("respawn", 150); if (!s) return;
    this.relay(s.t, 0.3);
    this.tone({ t: s.t + 0.04, type: "sawtooth", f: 70, f2: 240, glide: 0.25, dur: 0.32, a: 0.05, peak: 0.13, lp: 900 });
    this.tone({ t: s.t + 0.04, type: "square", f: 141, f2: 482, glide: 0.25, dur: 0.3, a: 0.05, peak: 0.04, lp: 1400 });
  }

  checkpoint(n: number): void {
    const s = this.go("cp", 300); if (!s) return;
    const t = s.t, root = 392 * semi(Math.min(Math.max(n - 1, 0), 8) * 2);
    this.relay(t, 0.3);
    this.clank(t, 1.6, 0.12);
    [0, 4, 7, 12].forEach((iv, i) => {
      const tt = t + 0.06 + i * 0.075, f = root * semi(iv);
      this.tone({ t: tt, type: "square", f, dur: 0.22, peak: 0.07, lp: 2600 });
      this.tone({ t: tt, type: "triangle", f: f * 2, dur: 0.18, peak: 0.05, detune: 6 });
    });
    const tc = t + 0.06 + 4 * 0.075;
    [0, 7, 12, 16].forEach((iv) => this.tone({ t: tc, type: "triangle", f: root * 2 * semi(iv), dur: 0.6, a: 0.01, peak: 0.05 }));
  }

  transition(): void {
    const s = this.go("trans", 1000); if (!s) return;
    const c = s.c, t = s.t, D = 1.8;
    // Motor sweep: spin up, hold, spin down — two detuned saws through a resonant LP.
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 5;
    lp.frequency.setValueAtTime(200, t); lp.frequency.exponentialRampToValueAtTime(1300, t + 0.7);
    lp.frequency.exponentialRampToValueAtTime(220, t + D);
    const g = c.createGain(); this.env(g.gain, t, 0.15, 0.2, D);
    g.gain.cancelScheduledValues(t + 0.15);
    g.gain.setValueAtTime(0.2, t + 0.15); g.gain.linearRampToValueAtTime(0.16, t + 1.35); g.gain.exponentialRampToValueAtTime(TINY, t + D);
    lp.connect(g); g.connect(this.fx);
    [1, 1.012, 2.003].forEach((k, i) => {
      const o = c.createOscillator(); o.type = i === 2 ? "square" : "sawtooth";
      o.frequency.setValueAtTime(50 * k, t); o.frequency.exponentialRampToValueAtTime(150 * k, t + 0.7);
      o.frequency.setValueAtTime(150 * k, t + 1.1); o.frequency.exponentialRampToValueAtTime(55 * k, t + D);
      const og = c.createGain(); og.gain.value = i === 2 ? 0.3 : 0.6;
      o.connect(og); og.connect(lp); o.start(t); o.stop(t + D + 0.05);
    });
    this.noise({ t, dur: D, a: 0.3, peak: 0.12, ft: "lowpass", f: 250, f2: 500, q: 0.8 });
    this.clank(t + 0.02, 1.2, 0.26);
    this.clank(t + 0.85, 1, 0.16, -0.4);
    this.clank(t + D - 0.12, 1.4, 0.3);
  }

  telegraph(ability: Ability): void {
    const s = this.go("tel", 120); if (!s) return;
    const c = s.c, t = s.t;
    switch (ability) {
      case "SHIFT": {
        this.noise({ t, dur: 0.45, a: 0.05, peak: 0.3, ft: "bandpass", f: 500, f2: 1500, q: 5 });
        this.tone({ t, type: "square", f: 47, f2: 60, dur: 0.45, a: 0.05, peak: 0.06, lp: 400 });
        [0.38, 0.46].forEach((d) => this.tone({ t: t + d, type: "square", f: 1800, f2: 3200, dur: 0.05, peak: 0.05 }));
        break;
      }
      case "PULSE": {
        const o = this.tone({ t, type: "sawtooth", f: 180, f2: 1500, dur: 0.75, a: 0.6, peak: 0.08, lp: 2500 });
        const trem = c.createOscillator(), tg = c.createGain(); tg.gain.value = 40;
        trem.frequency.setValueAtTime(8, t); trem.frequency.exponentialRampToValueAtTime(30, t + 0.75);
        trem.connect(tg); tg.connect(o.detune); trem.start(t); trem.stop(t + 0.8);
        this.tone({ t, f: 360, f2: 3000, dur: 0.75, a: 0.6, peak: 0.05 });
        break;
      }
      case "CRUSH": {
        this.noise({ t, dur: 0.55, a: 0.04, peak: 0.16, ft: "highpass", f: 2400, f2: 4200, q: 0.6 });
        this.noise({ t, dur: 0.5, a: 0.1, peak: 0.08, ft: "bandpass", f: 900, q: 1.5 });
        this.clank(t + 0.5, 1.1, 0.24);
        break;
      }
      case "MAGNET": {
        [90, 181, 271].forEach((f, i) => {
          const o = this.tone({ t, type: i === 1 ? "triangle" : "sine", f, dur: 0.9, a: 0.2, peak: 0.11 / (i + 1) });
          const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = 6 + i; lg.gain.value = f * 0.07;
          l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + 0.95);
        });
        break;
      }
      case "JAM": {
        for (let i = 0; i < 14; i++) {
          const tt = t + Math.random() * 0.6;
          this.noise({ t: tt, dur: rnd(0.006, 0.02), peak: rnd(0.06, 0.16), ft: "highpass", f: rnd(2500, 5000), pan: rnd(-0.5, 0.5) });
        }
        for (let i = 0; i < 4; i++) this.tone({ t: t + i * 0.14 + rnd(0, 0.03), type: "square", f: 120, dur: 0.05, peak: 0.04, lp: 1200 });
        break;
      }
    }
  }

  activate(ability: Ability): void {
    const s = this.go("act", 80); if (!s) return;
    const c = s.c, t = s.t;
    switch (ability) {
      case "PULSE":
        this.tone({ t, f: 100, f2: 34, glide: 0.25, dur: 0.32, peak: 0.55 });
        this.noise({ t, dur: 0.4, a: 0.01, peak: 0.22, ft: "bandpass", f: 2400, f2: 260, q: 1.2 });
        break;
      case "CRUSH": {
        const g = c.createGain(); this.env(g.gain, t, 0.03, 0.75, 0.65);
        const am = c.createOscillator(), amg = c.createGain(); am.type = "square"; am.frequency.value = 22; amg.gain.value = 0.3;
        am.connect(amg); amg.connect(g.gain); am.start(t); am.stop(t + 0.7); g.connect(this.fx);
        this.tone({ t, type: "sawtooth", f: 55, f2: 48, dur: 0.65, peak: 0.5, lp: 500, dest: g });
        this.noise({ t, dur: 0.65, peak: 0.4, ft: "lowpass", f: 700, q: 2, dest: g });
        this.clank(t, 1.5, 0.25);
        break;
      }
      case "MAGNET": {
        const g = c.createGain(); this.env(g.gain, t, 0.05, 0.3, 0.75); g.connect(this.fx);
        const am = c.createOscillator(), amg = c.createGain(); am.frequency.value = 13; amg.gain.value = 0.15;
        am.connect(amg); amg.connect(g.gain); am.start(t); am.stop(t + 0.8);
        this.tone({ t, f: 55, dur: 0.75, peak: 0.6, dest: g });
        this.tone({ t, type: "triangle", f: 110.5, dur: 0.75, peak: 0.3, dest: g });
        break;
      }
      case "SHIFT":
        this.noise({ t, dur: 0.45, a: 0.01, peak: 0.45, ft: "bandpass", f: 1300, f2: 450, q: 6 });
        this.tone({ t, type: "square", f: 72, f2: 52, dur: 0.4, peak: 0.16, lp: 500 });
        break;
      case "JAM":
        for (let i = 0; i < 6; i++) {
          const tt = t + i * 0.06;
          this.tone({ t: tt, type: "sawtooth", f: 150 - i * 12, dur: 0.035, a: 0.003, peak: 0.12, lp: 1500 });
          this.noise({ t: tt, dur: 0.012, peak: 0.1, ft: "highpass", f: 3000 });
        }
        break;
    }
  }

  rigType(): void {
    const s = this.go("type", 30); if (!s) return;
    this.tone({ t: s.t, type: "square", f: rnd(1300, 2300), dur: 0.016, a: 0.001, peak: 0.04, lp: 4000 });
    this.noise({ t: s.t, dur: 0.01, peak: 0.02, ft: "highpass", f: 5000 });
  }

  rigStatic(): void {
    const s = this.go("static", 60); if (!s) return;
    const { g } = this.noise({ t: s.t, dur: 0.12, a: 0.005, peak: 0.1, ft: "bandpass", f: 2600, q: 0.8 });
    for (let i = 1; i < 8; i++) g.gain.setValueAtTime(Math.random() < 0.4 ? 0.01 : rnd(0.04, 0.1), s.t + i * 0.013);
    g.gain.exponentialRampToValueAtTime(TINY, s.t + 0.12);
  }

  glitch(): void {
    const s = this.go("glitch", 80); if (!s) return;
    const t = s.t, o = this.tone({ t, type: "square", f: 400, dur: 0.16, a: 0.002, peak: 0.07, lp: 5000 });
    for (let i = 1; i < 10; i++) o.frequency.setValueAtTime(rnd(120, 3200), t + i * 0.015);
    const { g } = this.noise({ t, dur: 0.16, peak: 0.09, ft: "highpass", f: 1500 });
    for (let i = 1; i < 10; i++) g.gain.setValueAtTime(Math.random() < 0.5 ? TINY : 0.09, t + i * 0.015);
    g.gain.exponentialRampToValueAtTime(TINY, t + 0.16);
  }

  uiBlip(): void {
    const s = this.go("blip", 40); if (!s) return;
    this.tone({ t: s.t, type: "square", f: 880, dur: 0.04, peak: 0.05, lp: 3000 });
    this.tone({ t: s.t + 0.035, type: "triangle", f: 1320, dur: 0.07, peak: 0.06 });
  }

  boot(): void {
    const s = this.go("boot", 1000); if (!s) return;
    const t = s.t;
    this.relay(t, 0.35);
    this.clank(t + 0.01, 1.8, 0.2);
    this.tone({ t: t + 0.05, f: 50, dur: 1.1, a: 0.3, peak: 0.12 });
    this.tone({ t: t + 0.05, type: "sawtooth", f: 100, dur: 1.0, a: 0.3, peak: 0.04, lp: 400 });
    this.tone({ t: t + 0.12, f: 3000, f2: 7800, glide: 0.4, dur: 1.1, a: 0.35, peak: 0.018 }); // CRT whine
    this.noise({ t: t + 0.15, dur: 0.35, a: 0.02, peak: 0.08, ft: "bandpass", f: 300, f2: 120, q: 2 }); // degauss thunk
    this.relay(t + 0.7, 0.18);
  }

  offline(): void {
    const s = this.go("offline", 1000); if (!s) return;
    const t = s.t;
    this.frozenUntil = t + 1.2;
    // Wind down any running loops: pitch sag then cut.
    this.motorV?.forEach((m) => m.oscs.forEach((o) => { o.frequency.cancelScheduledValues(t); o.frequency.setTargetAtTime(15, t, 0.25); }));
    this.motorV?.forEach((m) => [m.f1, m.f2].forEach((sm) => sm.reset()));
    this.loop.gain.cancelScheduledValues(t);
    this.loop.gain.setValueAtTime(this.loop.gain.value, t);
    this.loop.gain.setTargetAtTime(0, t, 0.25);
    this.loop.gain.setTargetAtTime(0.8, t + 1.2, 0.2);
    this.tone({ t, type: "sawtooth", f: 220, f2: 28, glide: 0.9, dur: 0.95, peak: 0.14, lp: 1200 });
    this.tone({ t, f: 110, f2: 20, glide: 0.9, dur: 0.95, peak: 0.25 });
    this.tone({ t, f: 7800, f2: 400, glide: 0.5, dur: 0.5, peak: 0.015 });
    this.relay(t + 0.92, 0.35);
    this.noise({ t: t + 0.92, dur: 0.08, peak: 0.15, ft: "lowpass", f: 500 });
  }

  rigReturns(): void {
    const s = this.go("returns", 1500); if (!s) return;
    const t = s.t, D = 1.8;
    [[220, 0], [220, 4], [329.6, -3], [110, 0]].forEach(([f, det], i) =>
      this.tone({ t, type: i === 2 ? "triangle" : "sine", f, f2: f * 0.94, glide: D, dur: D, a: 0.8, peak: i === 3 ? 0.1 : 0.06, detune: det }));
    const { g } = this.noise({ t, dur: D * 0.9, a: 0.7, peak: 0.07, ft: "bandpass", f: 3200, f2: 1800, q: 0.9 });
    for (let i = 0; i < 6; i++) g.gain.setValueAtTime(rnd(0.005, 0.06), t + 0.75 + i * 0.09);
    g.gain.exponentialRampToValueAtTime(TINY, t + D * 0.9);
  }

  predictionSealed(): void {
    const s = this.go("seal", 100); if (!s) return;
    this.tone({ t: s.t, type: "square", f: 1200, dur: 0.035, peak: 0.04, lp: 3500 });
    this.tone({ t: s.t + 0.06, type: "square", f: 1800, dur: 0.05, peak: 0.04, lp: 3500 });
    this.tone({ t: s.t + 0.06, f: 160, f2: 90, dur: 0.06, peak: 0.12 });
  }

  predictionResolved(correct: boolean): void {
    const s = this.go("resolve", 100); if (!s) return;
    if (correct) {
      this.tone({ t: s.t, type: "triangle", f: 660, dur: 0.07, peak: 0.08 });
      this.tone({ t: s.t + 0.07, type: "triangle", f: 990, dur: 0.14, peak: 0.08 });
    } else {
      this.tone({ t: s.t, type: "square", f: 300, dur: 0.08, peak: 0.05, lp: 1200 });
      this.tone({ t: s.t + 0.09, type: "square", f: 212, dur: 0.16, peak: 0.05, lp: 1000 });
    }
  }
}

export const sfx = new Sfx();
