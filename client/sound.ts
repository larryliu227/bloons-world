/**
 * BLOONS WORLD — the noise, made out of nothing.
 *
 * There are no sound files, for the same reason there are no image files: a sound
 * that is a function cannot be missing, cannot 404, cannot be the wrong sample rate,
 * and costs nothing to download. The whole set is two hundred lines of Web Audio and
 * about a kilobyte of code.
 *
 * Everything here is one of three shapes:
 *
 *   NOISE   a burst of white noise through a filter. Footsteps, digging, gunfire —
 *           anything where the character is in the texture rather than the pitch.
 *   TONE    an oscillator with an envelope on it. Picking things up, hurting,
 *           anything that wants to be recognisably A NOTE.
 *   BOTH    a tone under a noise burst, which is what almost every real impact is:
 *           a thump and a clatter arriving together.
 *
 * Positional, so a pig behind you is behind you. Web Audio's panner does the work,
 * and the only thing this has to get right is telling it where the listener's head is
 * pointing — which is a thing the game already knows and would otherwise never say.
 */

const MAX_HEARING = 48;

/** How loud each kind of thing is, relative to everything else. */
const GAIN: Record<string, number> = {
  step: 0.22,
  dig: 0.5,
  break: 0.7,
  'dig-wood': 0.55, 'break-wood': 0.8,
  'dig-stone': 0.5, 'break-stone': 0.75,
  'dig-dirt': 0.5, 'break-dirt': 0.7,
  'dig-grass': 0.4, 'break-grass': 0.55,
  'dig-leaves': 0.4, 'break-leaves': 0.55,
  'dig-sand': 0.45, 'break-sand': 0.6,
  'dig-gravel': 0.5, 'break-gravel': 0.7,
  'dig-glass': 0.5, 'break-glass': 0.8,
  'dig-metal': 0.55, 'break-metal': 0.8,
  place: 0.6,
  pickup: 0.5,
  craft: 0.5,
  hurt: 0.8,
  die: 0.9,
  eat: 0.5,
  shoot: 1,
  'mob-hurt': 0.7,
  'mob-die': 0.8,
  climb: 0.3,
  splash: 0.6,
};

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** Muted until the first click: every browser refuses to make noise before one. */
  private armed = false;
  private lastAt = new Map<string, number>();

  /**
   * Start the audio engine. Must be called from inside a real user gesture.
   *
   * Browsers will not let a page make a sound until somebody has interacted with it,
   * which is the correct rule and is also the single most common reason a game is
   * silent for no apparent reason. Calling this from the ENTER WORLD click means it
   * has always happened by the time anything wants to be heard.
   */
  arm(): void {
    if (this.armed) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise();
      this.armed = true;
    } catch {
      /* no audio on this machine, and the game is exactly as playable without it */
    }
    void this.ctx?.resume();
  }

  /** Two seconds of white noise, made once and reused for every rustle and bang. */
  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Where the ears are and which way they point, so panning means anything. */
  listener(x: number, y: number, z: number, yaw: number, pitch: number): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const cp = Math.cos(pitch);
    const fx = Math.cos(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = Math.sin(yaw) * cp;
    // The modern properties where they exist, the deprecated call where they do not.
    if (l.positionX) {
      l.positionX.value = x;
      l.positionY.value = y;
      l.positionZ.value = z;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
      (l as unknown as { setOrientation(...a: number[]): void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /**
   * Play something, optionally somewhere.
   *
   * `throttle` is not a nicety: a machine gun at eight hundred rounds a minute and
   * a field of animals will each try to open a dozen oscillators a
   * second, and the result is not loud, it is a crackle and a dropped frame.
   */
  play(what: string, at?: [number, number, number], throttleMs = 0): void {
    if (!this.armed || !this.ctx || !this.master) return;
    if (throttleMs > 0) {
      const now = performance.now();
      const key = `${what}${at ? Math.round(at[0]) : ''}`;
      if (now - (this.lastAt.get(key) ?? -1e9) < throttleMs) return;
      this.lastAt.set(key, now);
    }
    const ctx = this.ctx;
    const t = ctx.currentTime;

    let out: AudioNode = this.master;
    if (at) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'linear';
      p.refDistance = 2;
      p.maxDistance = MAX_HEARING;
      p.rolloffFactor = 1;
      p.positionX.value = at[0];
      p.positionY.value = at[1];
      p.positionZ.value = at[2];
      p.connect(this.master);
      out = p;
    }
    const level = GAIN[what] ?? 0.5;
    switch (what) {
      // --- footfalls and digging: filtered noise, short and dull.
      case 'step':
        this.noise(out, t, 0.07, 900 + Math.random() * 500, level, 'lowpass');
        break;
      /*
       * Digging and breaking, once per material.
       *
       * Nine different SHAPES rather than one click at nine pitches, because that is
       * what actually distinguishes them: wood is a hollow knock with a body to it,
       * stone is a sharp crack with no body at all, sand is pure hiss, glass is a
       * bright shatter that rings. Retuning one sound gets you nine versions of the
       * same sound, which everybody can hear and nobody can name.
       */
      case 'dig-wood':
        this.noise(out, t, 0.08, 900, level * 0.7, 'bandpass');
        this.tone(out, t, 'triangle', 190 + Math.random() * 60, 120, 0.07, level * 0.5);
        break;
      case 'break-wood':
        this.noise(out, t, 0.2, 1000, level * 0.8, 'bandpass');
        this.tone(out, t, 'triangle', 160, 70, 0.22, level * 0.7);
        break;

      case 'dig-stone':
        this.noise(out, t, 0.06, 2600 + Math.random() * 1200, level * 0.8, 'highpass');
        break;
      case 'break-stone':
        this.noise(out, t, 0.16, 3000, level, 'highpass');
        this.noise(out, t, 0.3, 500, level * 0.5, 'lowpass');
        break;

      case 'dig-dirt':
        this.noise(out, t, 0.11, 420 + Math.random() * 200, level, 'lowpass');
        break;
      case 'break-dirt':
        this.noise(out, t, 0.2, 380, level, 'lowpass');
        this.tone(out, t, 'sine', 90, 50, 0.14, level * 0.5);
        break;

      case 'dig-grass':
      case 'dig-leaves':
        // A rustle: high, soft, and long enough to be a texture rather than a tick.
        this.noise(out, t, 0.16, 3800 + Math.random() * 1500, level * 0.5, 'highpass');
        break;
      case 'break-grass':
      case 'break-leaves':
        this.noise(out, t, 0.26, 3200, level * 0.6, 'highpass');
        break;

      case 'dig-sand':
        this.noise(out, t, 0.14, 5000, level * 0.55, 'highpass');
        break;
      case 'break-sand':
        this.noise(out, t, 0.3, 4200, level * 0.6, 'highpass');
        break;

      case 'dig-gravel':
        // Loose stones knocking together: three short clicks rather than one burst.
        for (let i = 0; i < 3; i++) {
          this.noise(out, t + i * 0.022, 0.05, 1800 + Math.random() * 1600, level * 0.5, 'bandpass');
        }
        break;
      case 'break-gravel':
        for (let i = 0; i < 5; i++) {
          this.noise(out, t + i * 0.028, 0.07, 1500 + Math.random() * 2000, level * 0.55, 'bandpass');
        }
        break;

      case 'dig-glass':
        this.noise(out, t, 0.05, 7000, level * 0.7, 'highpass');
        this.tone(out, t, 'sine', 2200, 1800, 0.05, level * 0.25);
        break;
      case 'break-glass':
        // The shatter, and then the pieces landing.
        this.noise(out, t, 0.1, 8000, level, 'highpass');
        for (let i = 0; i < 5; i++) {
          this.tone(out, t + i * 0.035, 'sine', 1600 + Math.random() * 2200, 900, 0.09, level * 0.2);
        }
        break;

      case 'dig-metal':
        this.tone(out, t, 'square', 900, 700, 0.06, level * 0.25);
        this.noise(out, t, 0.05, 3000, level * 0.5, 'bandpass');
        break;
      case 'break-metal':
        this.tone(out, t, 'square', 700, 300, 0.3, level * 0.3);
        this.noise(out, t, 0.14, 2400, level * 0.6, 'bandpass');
        break;

      // Fallbacks, for anything that forgot to say what it was made of.
      case 'dig':
        this.noise(out, t, 0.1, 1400 + Math.random() * 900, level, 'bandpass');
        break;
      case 'break':
        this.noise(out, t, 0.22, 2200, level, 'highpass');
        this.tone(out, t, 'triangle', 220, 70, 0.16, level * 0.5);
        break;
      case 'place':
        this.noise(out, t, 0.08, 700, level, 'lowpass');
        this.tone(out, t, 'sine', 160, 110, 0.09, level * 0.6);
        break;

      // --- things going right.
      case 'pickup':
        this.tone(out, t, 'square', 660, 990, 0.09, level * 0.35);
        break;
      case 'craft':
        this.tone(out, t, 'square', 440, 660, 0.08, level * 0.3);
        this.tone(out, t + 0.07, 'square', 660, 880, 0.1, level * 0.3);
        break;
      case 'eat':
        this.noise(out, t, 0.13, 600, level, 'lowpass');
        break;

      // --- things going wrong.
      case 'hurt':
        this.tone(out, t, 'sawtooth', 340, 120, 0.22, level * 0.4);
        this.noise(out, t, 0.1, 900, level * 0.5, 'bandpass');
        break;
      case 'die':
        this.tone(out, t, 'sawtooth', 300, 60, 0.8, level * 0.45);
        break;

      // --- gunfire: a crack, a body, and a tail.
      case 'shoot':
        this.noise(out, t, 0.05, 6000, level * 0.9, 'highpass');
        this.noise(out, t, 0.3, 400, level * 0.8, 'lowpass');
        this.tone(out, t, 'square', 120, 40, 0.14, level * 0.5);
        break;

      // --- animals.
      case 'mob-hurt':
        this.tone(out, t, 'sawtooth', 260, 150, 0.18, level * 0.35);
        this.noise(out, t, 0.09, 1200, level * 0.5, 'bandpass');
        break;
      case 'mob-die':
        this.tone(out, t, 'sawtooth', 200, 50, 0.55, level * 0.4);
        this.noise(out, t, 0.25, 800, level * 0.5, 'lowpass');
        break;
      case 'climb':
        this.noise(out, t, 0.06, 1100, level, 'bandpass');
        break;
      case 'splash':
        this.noise(out, t, 0.4, 1600, level, 'lowpass');
        break;
      default:
        this.noise(out, t, 0.1, 1000, level, 'bandpass');
    }
  }

  private noise(
    out: AudioNode, t: number, len: number, freq: number, gain: number, kind: BiquadFilterType,
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = kind;
    f.frequency.value = freq;
    f.Q.value = 1.1;
    const g = ctx.createGain();
    // A hard attack and an exponential tail, which is what almost every real impact
    // does and what a linear fade conspicuously does not.
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5, len);
    src.stop(t + len);
  }

  private tone(
    out: AudioNode, t: number, kind: OscillatorType,
    from: number, to: number, len: number, gain: number, wobble = 0,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = kind;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + len);
    if (wobble > 0) {
      // A second oscillator on the first one's pitch. This is the whole difference
      // between a groan and a beep.
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = wobble;
      depth.gain.value = from * 0.12;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + len);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + len);
  }
}
