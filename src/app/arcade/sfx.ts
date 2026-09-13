/**
 * Sound, synthesised rather than downloaded.
 *
 * A bow twang, an arrow thunk and a hit are a few hundred milliseconds of
 * oscillator and filtered noise each. Recording them would mean shipping audio
 * files for a page whose entire world is already generated in code, and the
 * files would outweigh the game.
 *
 * The context is created on the first user gesture because browsers refuse to
 * start one before that, and a muted game that never explains itself is worse
 * than a silent one.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  muted = false;

  /** Call from a click. Safe to call repeatedly. */
  resume() {
    try {
      this.ctx ??= new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      // No audio is survivable; the game is not about the sound.
      this.ctx = null;
    }
  }

  private gain(at: number, peak: number, decay: number): GainNode | null {
    if (!this.ctx || this.muted) return null;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    g.connect(this.ctx.destination);
    return g;
  }

  /** Short burst of filtered noise — the body of a twang, a thunk, a rustle. */
  private noise(at: number, decay: number, peak: number, freq: number, q = 1) {
    if (!this.ctx || this.muted) return;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * decay));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = this.gain(at, peak, decay);
    if (!g) return;
    src.connect(bp).connect(g);
    src.start(at);
    src.stop(at + decay);
  }

  private tone(at: number, from: number, to: number, decay: number, peak: number, type: OscillatorType = "sine") {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + decay);
    const g = this.gain(at, peak, decay);
    if (!g) return;
    o.connect(g);
    o.start(at);
    o.stop(at + decay);
  }

  /** Loosing an arrow: a low snap and the string's ring. */
  loose() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noise(t, 0.09, 0.28, 900, 1.2);
    this.tone(t, 220, 90, 0.14, 0.16, "triangle");
  }

  /** Arrow into straw. Dull, wooden, over quickly. */
  thunk() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noise(t, 0.11, 0.4, 260, 0.8);
    this.tone(t, 160, 60, 0.12, 0.22, "square");
  }

  /** A miss: the arrow going past into the trees. */
  miss() {
    if (!this.ctx) return;
    this.noise(this.ctx.currentTime, 0.22, 0.09, 2600, 0.6);
  }

  /** Taking an arrow. The only unpleasant sound in the set, deliberately. */
  hurt() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 300, 45, 0.32, 0.3, "sawtooth");
    this.noise(t, 0.18, 0.3, 420, 0.7);
  }

  /** A run of hits. Rises with the combo so it rewards without a number. */
  chime(step: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 520 * Math.pow(1.09, Math.min(12, step));
    this.tone(t, base, base * 1.6, 0.18, 0.12, "sine");
  }

  /** The horn that ends a round. */
  horn() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 180, 178, 0.55, 0.22, "sawtooth");
    this.tone(t + 0.3, 240, 238, 0.7, 0.2, "sawtooth");
  }

  close() {
    try {
      void this.ctx?.close();
    } catch {
      /* already gone */
    }
    this.ctx = null;
  }
}
