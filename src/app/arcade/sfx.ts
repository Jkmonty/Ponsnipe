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
import { LOOSES, MARKERS, THUNKS, loadPicks, type Picks, type Spec } from "./kit";

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
  /**
   * Which variant of each tunable sound to use.
   *
   * Set by the tuning page at /arcade/sounds and read back here, so a choice
   * made there is heard in the next round rather than only on that page.
   */
  picks: Picks = loadPicks();

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

  /**
   * Play a spec: the layers of one sound, at one moment.
   *
   * This is the only path the tunable sounds take, which is what makes the
   * tuning page trustworthy — it plays these same objects through this same
   * method, so what is auditioned is what ships.
   */
  playSpec(spec: Spec, at = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.t + at;
    for (const l of spec) {
      const when = t0 + (l.at ?? 0);
      if (l.kind === "tone") {
        this.tone(when, l.from, l.to ?? l.from, l.dur, l.gain, l.wave ?? "sine", l.attack ?? 0.006);
      } else {
        this.noise(when, l.dur, l.gain, l.from, l.to ?? l.from, l.filter ?? "bandpass", l.q ?? 1);
      }
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

  /*
   * The three tunable sounds.
   *
   * Each is a row in a table in kit.ts with several candidates, and each
   * plays whichever candidate is currently chosen. The reasoning about what
   * any of them is made of lives beside the numbers there, not here — here
   * they are only a lookup.
   */

  /** Loosing an arrow: the string, the stave and the shaft leaving. */
  loose() {
    this.playSpec(LOOSES[this.picks.loose].build());
  }

  /** The arrow landing. Kept low and quiet, under the marker. */
  thunk() {
    this.playSpec(THUNKS[this.picks.thunk].build());
  }

  /** The hit marker, and a second lower tick when it was a kill. */
  marker(kill = false) {
    this.playSpec(MARKERS[this.picks.marker].build(kill));
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
