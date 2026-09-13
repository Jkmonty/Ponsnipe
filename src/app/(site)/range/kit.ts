/**
 * The sounds, as data.
 *
 * Every effect in the range is a handful of layers — a tone that slides, a
 * burst of filtered noise — and writing them as objects rather than as code
 * buys one specific thing: the tuning page can play exactly what the game
 * plays. An audition that runs its own copy of the synthesis is auditioning
 * itself, and picking a winner there tells you nothing about the game.
 *
 * So the variants below are the real candidates. Whichever is chosen is the
 * one the round uses, and the choice survives a reload.
 */

export interface ToneLayer {
  kind: "tone";
  /** Seconds after the trigger. */
  at?: number;
  from: number;
  /** Slides to here across `dur`. Defaults to no slide. */
  to?: number;
  dur: number;
  gain: number;
  wave?: OscillatorType;
  attack?: number;
}

export interface NoiseLayer {
  kind: "noise";
  at?: number;
  from: number;
  to?: number;
  dur: number;
  gain: number;
  filter?: BiquadFilterType;
  q?: number;
}

export type Layer = ToneLayer | NoiseLayer;
export type Spec = Layer[];

export interface Variant<A extends unknown[] = []> {
  id: string;
  label: string;
  /** What is different about it, in words, for the tuning page. */
  note: string;
  build: (...args: A) => Spec;
}

/* ── the hit marker ───────────────────────────────────────────────────────
   The short dry tick that confirms a hit. What makes this family of sound
   read as struck metal rather than as a beep is partials at ratios that are
   not whole numbers — real metal does not ring in octaves — and almost no
   tail at all. The variants trade brightness against ring. */

/** One strike: a noise transient and a stack of inharmonic partials. */
function tick(
  at: number,
  base: number,
  level: number,
  decay: number,
  partials: readonly (readonly [number, number])[],
  bite: number,
): Spec {
  const out: Spec = [];
  if (bite > 0) {
    out.push({
      kind: "noise",
      at,
      from: 5200,
      to: 3000,
      dur: 0.012,
      gain: level * bite,
      filter: "highpass",
      q: 0.7,
    });
  }
  for (const [mult, g] of partials) {
    out.push({
      kind: "tone",
      at,
      from: base * mult,
      to: base * mult * 0.94,
      dur: decay,
      gain: level * g,
      wave: "triangle",
      attack: 0.001,
    });
  }
  return out;
}

const PARTIALS_METAL = [
  [1, 1],
  [1.48, 0.55],
  [1.97, 0.3],
] as const;

export const MARKERS: Variant<[boolean]>[] = [
  {
    id: "tight",
    label: "Tight",
    note: "3.0kHz, three partials, short. Bright and dry, with a little ring.",
    build: (kill) => [
      ...tick(0, 3000, 0.3, 0.085, PARTIALS_METAL, 0.5),
      ...(kill ? tick(0.055, 2100, 0.26, 0.085, PARTIALS_METAL, 0.5) : []),
    ],
  },
  {
    id: "sharp",
    label: "Sharp",
    note: "Higher and shorter — 3.8kHz, half the decay. More tink, less ring.",
    build: (kill) => [
      ...tick(0, 3800, 0.3, 0.05, PARTIALS_METAL, 0.65),
      ...(kill ? tick(0.05, 2600, 0.27, 0.05, PARTIALS_METAL, 0.65) : []),
    ],
  },
  {
    id: "glassy",
    label: "Glassy",
    note: "Two partials, wider apart, longer decay. More bell than click.",
    build: (kill) => [
      ...tick(0, 3200, 0.27, 0.16, [[1, 1], [2.76, 0.4]], 0.25),
      ...(kill ? tick(0.06, 2200, 0.24, 0.16, [[1, 1], [2.76, 0.4]], 0.25) : []),
    ],
  },
  {
    id: "clack",
    label: "Clack",
    note: "Mostly transient, barely any tone. A hard clack rather than a ring — the default.",
    build: (kill) => [
      ...tick(0, 2400, 0.26, 0.028, [[1, 1], [1.61, 0.4]], 1.3),
      ...(kill ? tick(0.045, 1700, 0.24, 0.028, [[1, 1], [1.61, 0.4]], 1.3) : []),
    ],
  },
];

/* ── the bow ─────────────────────────────────────────────────────────────
   A release is a snap, the stave's weight behind it, and the shaft leaving.
   The variants shift the balance between those three. */

export const LOOSES: Variant[] = [
  {
    id: "snap",
    label: "Snap",
    note: "Hard high transient with the stave under it — the default.",
    build: () => [
      { kind: "noise", from: 3200, to: 1200, dur: 0.028, gain: 0.42, q: 0.9 },
      { kind: "tone", from: 168, to: 62, dur: 0.2, gain: 0.3, wave: "triangle", attack: 0.002 },
      { kind: "tone", at: 0.004, from: 402, to: 210, dur: 0.085, gain: 0.11, attack: 0.001 },
      { kind: "noise", at: 0.025, from: 3800, to: 900, dur: 0.26, gain: 0.1, q: 0.7 },
    ],
  },
  {
    id: "deep",
    label: "Deep",
    note: "Heavier stave, lower snap. A warbow rather than a target bow.",
    build: () => [
      { kind: "noise", from: 2100, to: 700, dur: 0.035, gain: 0.34, q: 1 },
      { kind: "tone", from: 132, to: 48, dur: 0.3, gain: 0.4, wave: "triangle", attack: 0.002 },
      { kind: "tone", at: 0.006, from: 300, to: 150, dur: 0.13, gain: 0.13, attack: 0.001 },
      { kind: "noise", at: 0.03, from: 2600, to: 700, dur: 0.3, gain: 0.09, q: 0.7 },
    ],
  },
  {
    id: "whip",
    label: "Whip",
    note: "Less body, more of the shaft tearing away. Fast and thin.",
    build: () => [
      { kind: "noise", from: 4200, to: 1600, dur: 0.022, gain: 0.4, q: 0.8 },
      { kind: "tone", from: 200, to: 90, dur: 0.12, gain: 0.16, wave: "triangle", attack: 0.002 },
      { kind: "noise", at: 0.015, from: 6000, to: 1200, dur: 0.32, gain: 0.17, q: 0.5 },
    ],
  },
];

/* ── the arrow landing ───────────────────────────────────────────────────
   This fires at the same instant as the marker, so its job is to be felt
   without being heard over the tick. All three stay well below it. */

export const THUNKS: Variant[] = [
  {
    id: "body",
    label: "Body",
    note: "Low and quiet, nothing near the marker's band — the default.",
    build: () => [
      { kind: "tone", from: 190, to: 56, dur: 0.11, gain: 0.15, wave: "triangle", attack: 0.002 },
      { kind: "noise", from: 700, to: 220, dur: 0.07, gain: 0.1, filter: "lowpass", q: 1.2 },
    ],
  },
  {
    id: "thock",
    label: "Thock",
    note: "A woody knock over the body. More audible, more wooden.",
    build: () => [
      { kind: "tone", from: 210, to: 60, dur: 0.12, gain: 0.17, wave: "triangle", attack: 0.002 },
      { kind: "noise", from: 900, to: 300, dur: 0.08, gain: 0.16, q: 1.6 },
      { kind: "noise", at: 0.008, from: 2200, to: 800, dur: 0.05, gain: 0.05, filter: "highpass" },
    ],
  },
  {
    id: "soft",
    label: "Soft",
    note: "Straw swallowing it. Almost only a thud.",
    build: () => [
      { kind: "tone", from: 150, to: 48, dur: 0.13, gain: 0.13, wave: "sine", attack: 0.003 },
      { kind: "noise", from: 420, to: 160, dur: 0.06, gain: 0.07, filter: "lowpass", q: 1 },
    ],
  },
];

/** Which variant of each is in use. Indices into the tables above. */
export interface Picks {
  marker: number;
  loose: number;
  thunk: number;
}

/**
 * Chosen by ear on the bench at /arcade/sounds: clack, snap, body.
 *
 * The marker is the shortest and driest of the four — 15ms, almost entirely
 * transient, barely any tone under it. Which is the right answer for a sound
 * that fires at the same instant as the arrow landing: the less of it there
 * is, the more clearly it reads as a separate event rather than part of the
 * thud.
 */
export const DEFAULT_PICKS: Picks = { marker: 3, loose: 0, thunk: 0 };

export const PICKS_KEY = "ponsnipe.arcade.sfx.v1";

/** Read the saved choice. Anything unrecognised falls back to the defaults. */
export function loadPicks(): Picks {
  try {
    const raw = localStorage.getItem(PICKS_KEY);
    if (!raw) return { ...DEFAULT_PICKS };
    const p = JSON.parse(raw) as Partial<Picks>;
    const clamp = (v: unknown, n: number) =>
      typeof v === "number" && v >= 0 && v < n ? Math.floor(v) : 0;
    return {
      marker: clamp(p.marker, MARKERS.length),
      loose: clamp(p.loose, LOOSES.length),
      thunk: clamp(p.thunk, THUNKS.length),
    };
  } catch {
    return { ...DEFAULT_PICKS };
  }
}

export function savePicks(p: Picks) {
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify(p));
  } catch {
    /* a browser refusing storage is not worth an error here */
  }
}
