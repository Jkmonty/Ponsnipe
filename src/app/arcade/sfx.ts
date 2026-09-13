/**
 * Sound, synthesised rather than downloaded.
 *
 * Every noise here is built from oscillators and filtered noise at the moment
 * it plays. Recording them would mean shipping audio files for a page whose
 * entire world is already generated in code, and the files would outweigh the
 * game.
 *
 * The trick to a synthesised sound reading as real is that nothing physical is
 * one tone with one envelope. A bowstring is a hard transient, a body of wood
 * resonating, and a hiss of air, all decaying at different rates. An arrow
 * hitting straw is a thud with a dry rattle over it. So each of these layers
 * two or three voices with different lengths, and detunes anything repeated so
 * two shots in a row are never quite the same sound — the most obvious tell of
 * a synthesised effect is that it is bit-identical every time.
 *
 * The context is created on the first user gesture because browsers refuse to
 * start one before that.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  /** One bus, so the whole game can be ducked or muted in one place. */
  private bus: GainNode | null = null;
  muted = false;

  /** Call from a click. Safe to call repeatedly. */
  resume() {
    try {
      this.ctx ??= new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      if (!this.bus) {
        this.bus = this.ctx.createGain();
        this.bus.gain.value = 0.85;
        this.bus.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      // No audio is survivable; the game is not about the sound.
      this.ctx = null;
    }
  }

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * An envelope on the shared bus.
   *
   * The attack is short but never zero: a gain that jumps straight to full is
   * a click, and a click is the other great tell of fake audio.
   */
  private env(at: number, peak: number, attack: number, decay: number): GainNode | null {
    if (!this.ctx || !this.bus || this.muted) return null;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(this.bus);
    return g;
  }

  /**
   * Filtered noise. `to` slides the filter over the life of the sound, which
   * is what makes a burst read as something physical losing energy rather than
   * as a hiss somebody switched off.
   */
  private noise(
    at: number,
    dur: number,
    peak: number,
    from: number,
    to = from,
    type: BiquadFilterType = "bandpass",
    q = 1,
  ) {
    if (!this.ctx || this.muted) return;
    const len = Math.max(16, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 1.4;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, at);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, to), at + dur);
    const g = this.env(at, peak, 0.004, dur);
    if (!g) return;
    src.connect(f).connect(g);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  private tone(
    at: number,
    from: number,
    to: number,
    dur: number,
    peak: number,
    type: OscillatorType = "sine",
    attack = 0.006,
  ) {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
    const g = this.env(at, peak, attack, dur);
    if (!g) return;
    o.connect(g);
    o.start(at);
    o.stop(at + dur + attack + 0.02);
  }

  /** A little either side of 1, so nothing repeats exactly. */
  private vary(spread = 0.06): number {
    return 1 + (Math.random() * 2 - 1) * spread;
  }

  /**
   * Loosing an arrow.
   *
   * Three layers: the string snapping, the stave thumping low and woody, and
   * the shaft hissing away off the rest a moment later.
   */
  loose() {
    if (!this.ctx) return;
    const t = this.t;
    const v = this.vary();
    this.noise(t, 0.05, 0.34, 2600 * v, 700, "bandpass", 0.8);
    this.tone(t, 190 * v, 72, 0.17, 0.22, "triangle", 0.003);
    this.tone(t + 0.005, 460 * v, 300, 0.07, 0.08, "sine");
    this.noise(t + 0.03, 0.22, 0.07, 4200, 1400, "highpass", 0.6);
  }

  /** Arrow into a straw butt: a dull thud with a dry rattle over it. */
  thunk() {
    if (!this.ctx) return;
    const t = this.t;
    const v = this.vary(0.1);
    this.tone(t, 210 * v, 58, 0.13, 0.3, "triangle", 0.002);
    this.noise(t, 0.09, 0.26, 1100 * v, 260, "bandpass", 1.4);
    this.noise(t + 0.01, 0.14, 0.1, 3200, 900, "highpass", 0.7);
  }

  /**
   * The hit marker.
   *
   * Two very short, very bright blips a few milliseconds apart. The reason
   * this sound cuts through everything else in a shooter is that it sits in a
   * band nothing else occupies and is over before anything can mask it. A
   * kill drops the second blip instead of raising it, so the two are
   * distinguishable without looking at the screen.
   */
  marker(kill = false) {
    if (!this.ctx) return;
    const t = this.t;
    this.tone(t, 2400, 2300, 0.035, 0.2, "square", 0.001);
    this.tone(t + 0.035, kill ? 1500 : 3100, kill ? 1400 : 3000, 0.045, 0.17, "square", 0.001);
    this.noise(t, 0.03, 0.09, 6000, 4000, "highpass", 0.8);
  }

  /** A miss: the shaft going past into the trees. */
  miss() {
    if (!this.ctx) return;
    this.noise(this.t, 0.3, 0.1, 5200 * this.vary(), 900, "bandpass", 0.5);
  }

  /** Taking an arrow. The only unpleasant sound in the set, deliberately. */
  hurt() {
    if (!this.ctx) return;
    const t = this.t;
    const v = this.vary(0.08);
    this.tone(t, 160 * v, 44, 0.36, 0.34, "sawtooth", 0.002);
    this.noise(t, 0.12, 0.3, 700, 180, "lowpass", 1.2);
    this.tone(t + 0.04, 240 * v, 120, 0.3, 0.12, "triangle");
  }

  /** A run of hits. Rises with the combo so it rewards without a number. */
  chime(step: number) {
    if (!this.ctx) return;
    const t = this.t + 0.06;
    const base = 560 * Math.pow(1.06, Math.min(14, step));
    this.tone(t, base, base * 1.35, 0.22, 0.1, "sine", 0.01);
    this.tone(t, base * 2, base * 2.7, 0.16, 0.04, "sine", 0.01);
  }

  /**
   * The horn that ends a round.
   *
   * A hunting horn is a stopped pipe, so it is mostly odd harmonics. Stacking
   * three of those with a slow attack is the difference between a horn and a
   * synthesiser pretending to be one.
   */
  horn() {
    if (!this.ctx) return;
    const t = this.t;
    for (const [when, f] of [
      [0, 196],
      [0.34, 262],
      [0.68, 196],
    ] as const) {
      for (const [mult, level] of [
        [1, 0.2],
        [3, 0.07],
        [5, 0.03],
      ] as const) {
        this.tone(t + when, f * mult, f * mult * 0.99, when === 0.68 ? 0.9 : 0.34, level, "sine", 0.045);
      }
    }
  }

  close() {
    try {
      void this.ctx?.close();
    } catch {
      /* already gone */
    }
    this.ctx = null;
    this.bus = null;
  }
}
