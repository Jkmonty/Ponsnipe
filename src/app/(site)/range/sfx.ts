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

/**
 * Wind, and the music loop under a round: the two ambient layers, both
 * synthesised and both quiet by design — they are the floor the effects
 * above stand on, never competitors for attention with the marker or the
 * horn. Both start when a round starts (`roundStart()`, called explicitly
 * from `page.tsx`'s `play()` on Start and Again alike) and fade out when it
 * ends (`roundEnd()`, called from page.tsx's `s.over` effect). Not tied to
 * `resume()` or `horn()`: those two are "unlock the context" and "play the
 * horn sound" respectively, and bundling the ambience's lifecycle into
 * either of them was the bug the whole-branch review caught — the tuning
 * bench calls `resume()` on every button press, which used to start a
 * permanent wind bed on the bench's very first click. Neither ambient layer
 * has a file behind it: a CC0/CC-BY search turned up nothing that fit a
 * floor-noise role without either a licence that ruled it out or an audible
 * loop point, and both are easier to build exactly, and to prove seamless,
 * than to source blind.
 */

/** `whistle()` is called once per rendered frame a hostile arrow is in
 * flight, far more often than this, so what this bounds is the grain count
 * on a high-refresh display and not the audible result, which is one
 * continuous tone from the overlap. */
const WHISTLE_INTERVAL = 0.035;
/** Distance, in world units, at or beyond which the whistle sits at its
 * lowest, quietest pitch. The far rank fires from about 40 units out, so
 * this gives a far shot room to actually climb over its whole flight
 * instead of starting most of the way up the register already. */
const WHISTLE_MAX_DISTANCE = 45;

/** Distance, in world units, at or beyond which `tell()` sits at its quietest
 * — the same reach as `WHISTLE_MAX_DISTANCE`, reused rather than reinvented,
 * since a wind-up starting at the far rank has exactly as much ground
 * between it and the player as an arrow loosed from there does. */
const TELL_MAX_DISTANCE = WHISTLE_MAX_DISTANCE;
/** `tell()`'s loudest, right on top of the player — well under `MARKERS`'
 * own quietest layer (0.1 or more at every gain in kit.ts), so the tell a
 * wind-up gives off can never be mistaken for the confirmation a hit gives
 * back. */
const TELL_LEVEL_NEAR = 0.09;
/** `tell()`'s quietest, at or beyond `TELL_MAX_DISTANCE` — still audible
 * against the wind bed (`WIND_LEVEL` 0.035) rather than sitting exactly on
 * top of it, since a far wind-up is still a threat worth hearing, just the
 * quietest one on the range. */
const TELL_LEVEL_FAR = 0.045;

/** The wind's steady-state level, and how long it takes to reach or leave it.
 * Deliberately under every effect's quietest layer (the thunk and miss noise
 * bursts sit around 0.1) so it can never read as a sound in its own right. */
const WIND_LEVEL = 0.035;
const WIND_FADE = 1.4;

/**
 * The music loop's length, and the chord it renders once and then repeats.
 *
 * Every frequency here is an exact multiple of 1/LOOP_SECONDS, so every
 * partial completes a whole number of cycles across the buffer: the
 * waveform's value and slope at the last sample equal its value and slope at
 * the first, by construction, which is what makes the loop click-free. The
 * detuned pair beats once, slowly, over the full loop rather than never or
 * audibly — the only motion in an otherwise static drone. No filter touches
 * this signal: a filter has a startup transient that would not have settled
 * by the time playback reaches the far side of the loop, which would put a
 * seam exactly where there must not be one.
 */
const LOOP_SECONDS = 8;
const LOOP_LEVEL = 0.045;
const LOOP_FADE = 1.6;
const DRONE_PARTIALS: readonly (readonly [number, number])[] = [
  [55, 0.5], // root
  [55.125, 0.5], // root, detuned by exactly 1 / LOOP_SECONDS Hz — one slow beat per loop
  [82.5, 0.3], // fifth
  [110, 0.18], // octave
];

/**
 * How the music loop tightens for wave 2 — Phase 2 built this loop with the
 * comment that it "tightens for wave 2" and then deliberately left that
 * behaviour unwired, since waves did not exist yet. `World.step` now calls
 * `Sfx.setWave` once per wave change with `waves.ts`'s own `wave` number,
 * and this is the one thing that call changes: the already-playing
 * `AudioBufferSourceNode`'s own `playbackRate`, ramped rather than snapped.
 *
 * This is the same loop, not a second layer under it — `musicStart` renders
 * `DRONE_PARTIALS` into one buffer exactly once per round and plays it back
 * through one node throughout; `setWave` only ever touches that node's own
 * `playbackRate` AudioParam. A resample is also the one way to "tighten" a
 * fixed buffer without decoding or re-synthesising anything: every partial
 * in `DRONE_PARTIALS` rises by the same ratio (root 55Hz becomes
 * 55 * MUSIC_TIGHTEN_RATE), and the 8-second loop is read in 8 /
 * MUSIC_TIGHTEN_RATE seconds — audibly faster and higher, not merely
 * louder. The loop's click-free seam (see `LOOP_SECONDS`'s own comment)
 * survives this unchanged: `loop = true` and a non-1 `playbackRate` both
 * read the same underlying buffer, whose first and last samples already
 * match in value and slope, so scaling *how fast* it is read cannot
 * introduce a seam that scaling *what* is read would not already have.
 *
 * `musicRateForWave` is exported and kept a plain function of one number
 * specifically so it can be asserted in `tests/range.test.ts` without an
 * `AudioContext` — nobody on this project can hear whether wave 2 actually
 * sounds tighter, so what is checked instead is the number the tightening
 * is built from: wave 2's rate must exceed every earlier wave's, by a
 * margin large enough to be a deliberate change and not floating-point
 * noise, and the resulting root frequency and loop duration are worked out
 * arithmetically in that test rather than asserted by ear.
 */
const MUSIC_BASE_RATE = 1;
const MUSIC_TIGHTEN_RATE = 1.18;
/** How long the ramp between rates takes, so a wave boundary is heard as a
    tightening over a second or so rather than a jump-cut in pitch. */
const MUSIC_RATE_RAMP = 1.2;

export function musicRateForWave(wave: number): number {
  return wave >= 2 ? MUSIC_TIGHTEN_RATE : MUSIC_BASE_RATE;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  /** One bus, so the whole game can be ducked or muted in one place. */
  private bus: GainNode | null = null;
  /** Decoded takes, by name. Empty until the kit loads, and maybe forever. */
  private kit = new Map<string, AudioBuffer[]>();
  private loading = false;
  muted = false;
  /** Set for exactly the span of a round, so a promise that resolves after
   * the round already ended (see `musicStart`) knows not to start anyway. */
  private roundActive = false;
  /** The last `whistle()` grain's start time, for `WHISTLE_INTERVAL`. Starts
   * below any real context time so the very first call is never throttled —
   * a fresh context's `currentTime` is 0, the same as this field's default
   * would otherwise be. */
  private lastWhistle = -Infinity;
  private wind: { src: AudioBufferSourceNode; lfo: OscillatorNode; gain: GainNode } | null = null;
  private music: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** The rendered drone, built once offline and reused by every round. */
  private loopReady: Promise<AudioBuffer> | null = null;
  /**
   * Which variant of each tunable sound to use.
   *
   * Set by the tuning page at /arcade/sounds and read back here, so a choice
   * made there is heard in the next round rather than only on that page.
   */
  picks: Picks = loadPicks();

  /**
   * Unlock the context. Call from a click. Safe to call repeatedly.
   *
   * This means only "the AudioContext exists and is running" — it used to
   * also start the wind and the drone (via `roundStart()`), which meant the
   * tuning bench's own `engine()`, calling this on every single button
   * press, started a permanent ambience bed on its first click. Starting a
   * round is now something a caller asks for explicitly (see `roundStart`).
   */
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
      // No audio is survivable; the game is not about the sound — but leave
      // nothing half-built behind: an orphaned `bus` pointing into a context
      // that failed to fully come up would look truthy to the next call in
      // here, which would then try to reuse a node from a dead context and
      // have every `connect()` after that throw.
      try {
        void this.ctx?.close();
      } catch {
        /* already gone, or never really up */
      }
      this.ctx = null;
      this.bus = null;
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
   * An envelope, on the shared bus by default.
   *
   * The attack is short but never zero: a gain that jumps straight to full is
   * a click, and a click is the other great tell of fake audio.
   *
   * `dest` defaults to `this.bus` — every existing caller gets exactly the
   * routing it always had — and is otherwise the one seam a caller can use
   * to route a sound somewhere other than straight to the bus. `tell()`
   * (below) is the only caller that ever passes one: a `StereoPannerNode`
   * sitting between this envelope and the bus, so that one sound can carry a
   * direction without every other sound in the file paying for a panner it
   * does not need.
   */
  private env(at: number, peak: number, attack: number, decay: number, dest: AudioNode | null = this.bus): GainNode | null {
    if (!this.ctx || !dest || this.muted) return null;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(dest);
    return g;
  }

  /**
   * Filtered noise. `to` slides the filter over the life of the sound, which
   * is what makes a burst read as something physical losing energy rather than
   * as a hiss somebody switched off. `dest` is `env`'s own seam, threaded
   * through unchanged.
   */
  private noise(
    at: number,
    dur: number,
    peak: number,
    from: number,
    to = from,
    type: BiquadFilterType = "bandpass",
    q = 1,
    dest: AudioNode | null = this.bus,
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
    const g = this.env(at, peak, 0.004, dur, dest);
    if (!g) return;
    src.connect(f).connect(g);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  /** A tone. `dest` is `env`'s own seam, threaded through unchanged — see its
      own comment for what it is for. */
  private tone(
    at: number,
    from: number,
    to: number,
    dur: number,
    peak: number,
    type: OscillatorType = "sine",
    attack = 0.006,
    dest: AudioNode | null = this.bus,
  ) {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
    const g = this.env(at, peak, attack, dur, dest);
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

  /*
   * There was a `creak()` here: the draw's rasp, a grain of filtered noise
   * per frame whose pitch and level climbed with how far the string was
   * back. It is gone with the draw itself. It was synthesised rather than
   * sampled for one reason — it tracked a continuously changing value, which
   * a fixed sample cannot — and a click has no such value to track: one
   * grain at the one fixed draw is a constant sound landing in the same
   * millisecond as `loose()`, which already has the release in it. So it is
   * retired rather than rewired.
   */

  /**
   * The incoming whistle of a hostile arrow, called every frame one is in
   * flight (see `World.step`, right after `stepArrows`) with its real,
   * current distance to the player. This is the first sound in this project
   * tuned by something in the world rather than a fixed envelope — a canned
   * sweep started at launch cannot know how far a shot actually has to
   * travel, and a far-rank arrow crosses roughly half again the ground a
   * near-rank one does, so distance, not elapsed time, is what has to drive
   * the climb. Throttled by `WHISTLE_INTERVAL`: grains overlap into one
   * continuous tone rather than flooding the graph with one per frame.
   */
  whistle(distance: number) {
    if (!this.ctx || this.muted) return;
    const t = this.t;
    if (t - this.lastWhistle < WHISTLE_INTERVAL) return;
    this.lastWhistle = t;
    const near = 1 - Math.max(0, Math.min(1, distance / WHISTLE_MAX_DISTANCE));
    const freq = 480 + near * 1500; // a low pass-by out at range, climbing toward a shriek as it closes
    const level = 0.05 + near * 0.1; // always under the marker, loudest right as it arrives
    this.tone(t, freq, freq * 1.08, 0.08, level, "sine", 0.004);
  }

  /**
   * A hostile butt's wind-up starting — the visual tell's audible half (see
   * `World.step`'s firing block, which calls this once per wind-up and never
   * once per frame the way `whistle` above is called: this announces a
   * moment beginning, not a continuously changing distance).
   *
   * Built the same shape `whistle` already is — the same `near` fraction of
   * `distance` against a `MAX_DISTANCE`, driving how loud it is — but
   * everything about its character is deliberately unlike every other sound
   * in the set, so it cannot be mistaken for one of them: two short rising
   * triangle notes, cooler and quieter than `marker`'s bright confirmation,
   * with no continuous sweep to read as `whistle`'s incoming arrow and no
   * low sawtooth thump to read as `hurt`'s impact. It should sound like a
   * threat clearing its throat, not like feedback on anything the player
   * just did.
   *
   * `pan`, -1 hard left to +1 hard right, carries the butt's bearing so an
   * off-screen wind-up says which way to look and not only that one is
   * coming. Routed through a `StereoPannerNode` sitting between this sound's
   * own envelope and the bus — the one sound in this file that needs one,
   * which is why `tone`'s `dest` seam exists at all rather than every call
   * site being wired to the bus directly. Falls back to the plain bus (no
   * panning, still audible) if `StereoPannerNode` is not available, the same
   * "degrade, do not go silent" rule every other sound in this file follows.
   */
  tell(distance: number, pan: number) {
    if (!this.ctx || !this.bus || this.muted) return;
    const t = this.t;
    const near = 1 - Math.max(0, Math.min(1, distance / TELL_MAX_DISTANCE));
    const level = TELL_LEVEL_FAR + near * (TELL_LEVEL_NEAR - TELL_LEVEL_FAR);
    let dest: AudioNode = this.bus;
    if (typeof StereoPannerNode !== "undefined") {
      const panner = new StereoPannerNode(this.ctx, { pan: Math.max(-1, Math.min(1, pan)) });
      panner.connect(this.bus);
      dest = panner;
    }
    this.tone(t, 340, 430, 0.13, level, "triangle", 0.012, dest);
    this.tone(t + 0.1, 430, 520, 0.15, level * 0.8, "triangle", 0.012, dest);
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
    // Just a sound now — it used to also call `roundEnd()`, which is why the
    // sound bench's own "End of round" button happened to be the one way to
    // stop the wind bed the bench's every other button started. `roundEnd()`
    // is page.tsx's call now (the `s.over` effect), same as `roundStart()`.
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

  /**
   * Start the wind and the music loop. Called explicitly from `play()` in
   * page.tsx on Start and Again alike — idempotent, since both halves no-op
   * if already running. Not called from `resume()` any more: the tuning
   * bench calls `resume()` on every single button press, and a round is a
   * different thing from "the context is unlocked".
   */
  roundStart() {
    this.roundActive = true;
    this.windStart();
    this.musicStart();
  }

  /** The other half of `roundStart`, called explicitly from page.tsx's
   * `s.over` effect rather than from `horn()` — a sound and "the round just
   * ended" are two different signals that used to be bundled into one call. */
  roundEnd() {
    this.roundActive = false;
    this.windEnd();
    this.musicEnd();
  }

  /**
   * A continuous low noise bed, band-passed and slowly wobbling — the floor
   * the other sounds stand on, not a sound in its own right. Fades in over
   * `WIND_FADE` rather than starting with a click, and the buffer is a plain
   * loop of raw noise: noise has no periodicity to protect at the seam the
   * way a tone does, so a bare loop point is inaudible.
   */
  private windStart() {
    if (!this.ctx || !this.bus || this.muted || this.wind) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const len = Math.max(16, Math.floor(ctx.sampleRate * 3));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.6;
    filter.frequency.value = 320;

    // A slow wobble on the centre frequency so the bed breathes rather than
    // sitting on one dead pitch.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 90;
    lfo.connect(lfoGain).connect(filter.frequency);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(WIND_LEVEL, t + WIND_FADE);

    src.connect(filter).connect(gain).connect(this.bus);
    src.start(t);
    lfo.start(t);

    this.wind = { src, lfo, gain };
  }

  /** Fade the wind out and stop its nodes — explicitly, rather than trusting
   * that nobody notices a source left running under the between-round menu.
   * `stop()` is scheduled on the audio clock, not a JS timer, so it lands
   * even if the tab is throttled in the background. */
  private windEnd() {
    const w = this.wind;
    this.wind = null;
    if (!this.ctx || !w) return;
    const t = this.ctx.currentTime;
    w.gain.gain.cancelScheduledValues(t);
    w.gain.gain.setValueAtTime(Math.max(0.0001, w.gain.gain.value), t);
    w.gain.gain.exponentialRampToValueAtTime(0.0001, t + WIND_FADE);
    const stopAt = t + WIND_FADE + 0.05;
    w.src.stop(stopAt);
    w.lfo.stop(stopAt);
  }

  /**
   * Render the drone once, offline, and cache it — it never changes, so
   * synthesising it fresh every round would be wasted work. Kept free of
   * `this.ctx`/`this.bus`: it only needs a sample rate, which is what lets
   * it be rendered and inspected (its seam, in particular) without a live
   * AudioContext at all.
   */
  private buildLoop(sampleRate: number): Promise<AudioBuffer> {
    /*
     * `new OfflineAudioContext` and everything below it is synchronous, and
     * this used to run unguarded inside `resume()`'s own try/catch (via
     * `resume → roundStart → musicStart → buildLoop`) — so an old WebKit
     * that only exposes `webkitOfflineAudioContext`, or a build that rejects
     * a 48kHz offline rate, silenced every other sound in the game along
     * with the drone. `roundStart()` is no longer nested inside `resume()`
     * (see above), but this still must not throw synchronously out of here:
     * the caller is `musicStart`, which only ever attaches a `.catch` to
     * what this function *returns* — a throw before it returns anything
     * walks straight past that `.catch` and out into whatever called
     * `musicStart` instead. A rejected promise is what "fail quietly, one
     * sound short" actually looks like from this function's own signature.
     */
    try {
      const octx = new OfflineAudioContext(1, Math.round(LOOP_SECONDS * sampleRate), sampleRate);
      for (const [freq, gain] of DRONE_PARTIALS) {
        const o = octx.createOscillator();
        o.type = "sine";
        o.frequency.value = freq;
        const g = octx.createGain();
        g.gain.value = gain * 0.22; // headroom for the stack; the real level comes from LOOP_LEVEL on playback
        o.connect(g).connect(octx.destination);
        o.start(0);
        o.stop(LOOP_SECONDS);
      }
      return octx.startRendering();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Start the music loop once it has rendered. A no-op if one is already
   * playing, and abandoned quietly if the round has already ended by the
   * time the offline render resolves. */
  private musicStart() {
    if (!this.ctx || !this.bus || this.muted || this.music) return;
    const ctx = this.ctx;
    this.loopReady ??= this.buildLoop(ctx.sampleRate).catch((e) => {
      this.loopReady = null; // let the next round try again rather than staying broken forever
      throw e;
    });
    void this.loopReady
      .then((buf) => {
        if (!this.ctx || !this.bus || !this.roundActive || this.music) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = this.ctx.createGain();
        const t = this.ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(LOOP_LEVEL, t + LOOP_FADE);
        src.connect(gain).connect(this.bus);
        src.start(t);
        this.music = { src, gain };
      })
      .catch(() => {
        // No loop this round is survivable the same way a missing kit take is.
      });
  }

  /** The mirror of `windEnd`, for the music loop. */
  private musicEnd() {
    const m = this.music;
    this.music = null;
    if (!this.ctx || !m) return;
    const t = this.ctx.currentTime;
    m.gain.gain.cancelScheduledValues(t);
    m.gain.gain.setValueAtTime(Math.max(0.0001, m.gain.gain.value), t);
    m.gain.gain.exponentialRampToValueAtTime(0.0001, t + LOOP_FADE);
    m.src.stop(t + LOOP_FADE + 0.05);
  }

  /**
   * Cue the music loop's own tightening for the round's current wave — see
   * `musicRateForWave`'s own comment for what this changes and why. A no-op
   * before the loop has actually started (`musicStart`'s offline render is
   * asynchronous, so a wave-0-to-1 boundary crossed in the first moment of
   * a round could in principle land before `this.music` exists) rather than
   * queuing anything: `World` calls this again on every wave change, not
   * only once, so the next call after the loop starts catches it.
   */
  setWave(wave: number) {
    if (!this.ctx || !this.music) return;
    const target = musicRateForWave(wave);
    const rate = this.music.src.playbackRate;
    const t = this.ctx.currentTime;
    rate.cancelScheduledValues(t);
    rate.setValueAtTime(rate.value, t);
    rate.linearRampToValueAtTime(target, t + MUSIC_RATE_RAMP);
  }

  close() {
    // ctx.close() below stops every node on this context regardless, but
    // stopping the ambient ones by hand costs nothing and says plainly that
    // they were accounted for rather than left to the context to catch.
    try {
      this.wind?.src.stop();
      this.wind?.lfo.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.music?.src.stop();
    } catch {
      /* already stopped */
    }
    this.wind = null;
    this.music = null;
    this.roundActive = false;
    // Not reachable today — nothing closes an Sfx and then resumes the same
    // instance — but a fresh context's clock starts near zero, and a stale
    // `lastWhistle` left over from the old one would throttle the whistle
    // off for good. The same trap the -Infinity default exists to avoid at
    // construction, reset here so it still doesn't apply after a close.
    this.lastWhistle = -Infinity;
    try {
      void this.ctx?.close();
    } catch {
      /* already gone */
    }
    this.ctx = null;
    this.bus = null;
  }
}
