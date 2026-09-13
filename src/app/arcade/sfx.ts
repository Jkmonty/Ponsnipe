/**
 * Sound: recorded where a recording wins, synthesised where it does not.
 *
 * The kit in /arcade/sfx is CC0 from Kenney — impacts, cloth and metal, three
 * takes of most things. Recordings carry the fast, messy detail that betrays
 * synthesis instantly: the scrape of an arrow leaving the rest, the way straw
 * absorbs a hit. Provenance is in public/arcade/CREDITS.md.
 *
 * Synthesis stays for what no small sample can do. The low thump of a stave
 * the size of a person plays underneath the recorded string, because neither
 * half sounds like a bow alone. The horn and the combo chime are wholly
 * synthesised, since a tuned sound that has to rise with a counter cannot be
 * a fixed recording.
 *
 * Every path falls back. If the kit does not download, each sound drops to
 * its synthesised version rather than going silent, so bad audio beats no
 * audio and a blocked request is never a broken game.
 *
 * The context is created on the first user gesture because browsers refuse to
 * start one before that.
 */
/**
 * The recorded kit: how many variants of each sound sit in /arcade/sfx.
 *
 * Several takes of each, because the surest sign a game's audio is fake is
 * hearing the identical waveform twice in a row. Three arrows into straw
 * should be three slightly different noises, and no amount of detuning one
 * recording does what three recordings do.
 */
const KIT: Record<string, number> = {
  hurt: 3,
  miss: 2,
};

export class Sfx {
  private ctx: AudioContext | null = null;
  /** One bus, so the whole game can be ducked or muted in one place. */
  private bus: GainNode | null = null;
  /** Decoded takes, by name. Empty until the kit loads, and maybe forever. */
  private kit = new Map<string, AudioBuffer[]>();
  private loading = false;
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
      this.load();
    } catch {
      // No audio is survivable; the game is not about the sound.
      this.ctx = null;
    }
  }

  /**
   * Fetch and decode the kit once, in the background.
   *
   * Nothing waits on this. Until it lands — and permanently, if it never
   * does — every sound falls through to the synthesised version below, so a
   * failed download costs fidelity rather than silence.
   */
  private load() {
    if (this.loading || !this.ctx) return;
    this.loading = true;
    for (const [name, takes] of Object.entries(KIT)) {
      for (let i = 0; i < takes; i++) {
        void fetch(`/arcade/sfx/${name}${i}.ogg`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((b) => this.ctx!.decodeAudioData(b))
          .then((buf) => {
            const list = this.kit.get(name) ?? [];
            list.push(buf);
            this.kit.set(name, list);
          })
          .catch(() => {
            /* one missing take is not worth a message; the synth covers it */
          });
      }
    }
  }

  /**
   * Play one take of a recorded sound, if the kit has it.
   *
   * The playback rate is nudged a few percent each time, which shifts pitch
   * and length together the way a slightly different strike would, on top of
   * the variation between takes.
   */
  private sample(name: string, gain = 1, spread = 0.07, at = 0): boolean {
    const takes = this.kit.get(name);
    if (!this.ctx || !this.bus || this.muted || !takes?.length) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = takes[Math.floor(Math.random() * takes.length)];
    src.playbackRate.value = this.vary(spread);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.bus);
    src.start(this.t + at);
    return true;
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
   * Four things happen at once and none of them is the same length: the
   * string snaps, the stave thumps low and woody, the shaft scrapes off the
   * rest, and the whole lot recedes as a falling hiss.
   *
   * The recorded take that used to sit under this was cloth, and cloth is
   * what it sounded like. This is built instead, where the transient can be
   * made as sharp as it needs to be — the snap is the sound; everything else
   * is the body behind it.
   */
  loose() {
    if (!this.ctx || this.muted) return;
    const t = this.t;
    const v = this.vary();
    // The snap: brief, hard, high.
    this.noise(t, 0.028, 0.42, 3200 * v, 1200, "bandpass", 0.9);
    // The stave: the weight behind it.
    this.tone(t, 168 * v, 62, 0.2, 0.3, "triangle", 0.002);
    this.tone(t + 0.004, 402 * v, 210, 0.085, 0.11, "sine", 0.001);
    // The shaft going away.
    this.noise(t + 0.025, 0.26, 0.1, 3800, 900, "bandpass", 0.7);
  }

  /** Arrow into a straw butt: a dull thud with a dry rattle over it. */
  thunk() {
    if (!this.ctx) return;
    const t = this.t;
    const v = this.vary(0.1);
    /*
     * Low and quiet, deliberately.
     *
     * This fires at the same instant as the hit marker, and the marker is
     * the sound that has to land. Three effects stacking on one hit is how
     * you get mush instead of a confirmation, so this keeps only the body —
     * enough to feel the arrow arrive, nothing in the marker's band.
     */
    this.tone(t, 190 * v, 56, 0.11, 0.15, "triangle", 0.002);
    this.noise(t, 0.07, 0.1, 700 * v, 220, "lowpass", 1.2);
  }

  /**
   * The hit marker.
   *
   * The sound everyone knows from shooters is a very short, very dry,
   * bright metallic tick — about fifty milliseconds, nearly all of its
   * energy between two and six kilohertz, no tail at all. It carries over
   * gunfire because it sits in a band nothing else occupies and is finished
   * before anything can mask it.
   *
   * Three partials at inharmonic ratios are what make it read as metal
   * rather than as a beep: struck metal does not ring in whole-number
   * multiples, and a single sine at 3kHz sounds like a microwave. A tiny
   * filtered-noise transient at the front supplies the strike itself.
   *
   * Built here rather than sampled. The original is Activision's and not
   * ours to ship; this is the same species of sound, made from scratch.
   */
  marker(kill = false) {
    if (!this.ctx || this.muted) return;
    const t = this.t;
    const tick = (at: number, base: number, level: number) => {
      // The strike.
      this.noise(at, 0.012, level * 0.5, 5200, 3000, "highpass", 0.7);
      // The body: three close, deliberately unrelated partials.
      for (const [mult, g] of [
        [1, 1],
        [1.48, 0.55],
        [1.97, 0.3],
      ] as const) {
        this.tone(at, base * mult, base * mult * 0.94, 0.085, level * g, "triangle", 0.001);
      }
    };

    tick(t, 3000, 0.3);
    // A kill is the same tick answered a little lower — recognisable as a
    // kill without having to look away from where you are aiming.
    if (kill) tick(t + 0.055, 2100, 0.26);
  }

  /** A miss: the shaft going past into the trees. */
  miss() {
    if (!this.ctx) return;
    if (this.sample("miss", 0.35, 0.12)) return;
    this.noise(this.t, 0.3, 0.1, 5200 * this.vary(), 900, "bandpass", 0.5);
  }

  /** Taking an arrow. The only unpleasant sound in the set, deliberately. */
  hurt() {
    if (!this.ctx) return;
    const t = this.t;
    const v = this.vary(0.08);
    // The recorded impact lands, and a low tone under it carries the damage.
    const real = this.sample("hurt", 0.95, 0.09);
    this.tone(t, 160 * v, 44, 0.36, real ? 0.16 : 0.34, "sawtooth", 0.002);
    if (!real) {
      this.noise(t, 0.12, 0.3, 700, 180, "lowpass", 1.2);
      this.tone(t + 0.04, 240 * v, 120, 0.3, 0.12, "triangle");
    }
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
