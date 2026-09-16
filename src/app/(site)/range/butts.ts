import * as T from "three";
import type { Stock } from "./world";
import { rand } from "./rand";

/**
 * The four ways a target can hold itself up, chosen once when it rises
 * (`pickBehaviour`) and read every frame after by `stepButt`, switched on
 * `b.behaviour`:
 *
 * - `stand`: rises and stays, as every butt used to.
 * - `drift`: tracks sideways along its rank, bouncing back at the edge —
 *   the motion every butt had unconditionally before this type existed.
 * - `peek`: rises for `PEEK_WINDOW` seconds and drops, whether hit or not.
 * - `swing`: hangs from a branch and swings through a shallow, bounded arc.
 */
export type Behaviour = "stand" | "drift" | "peek" | "swing";

/**
 * The two ranks a target can rise in, replacing `LANES` as what decides a
 * butt's own depth (see the comment on `LANES` below for why). `z` is where
 * it stands, `faceScale` how large its face is drawn and hit-tested against,
 * `bonus` the multiplier `resolveButtHit` applies on top of the existing
 * ring multiplier — a far hit is smaller to land and worth twice as much.
 */
export type Rank = "near" | "far";

export const RANKS: Record<Rank, { z: number; faceScale: number; bonus: number }> = {
  near: { z: -22, faceScale: 1, bonus: 1 },
  far: { z: -40, faceScale: 0.5, bonus: 2 },
};

/** How long a `peek` stays fully up before it drops on its own — hit or not. */
export const PEEK_WINDOW = 1.8;

/** How far a `swing` travels either side of the branch it hangs from. */
export const SWING_AMPLITUDE = 4.5;

/** How fast a `swing` sweeps through its arc, in radians per second. */
export const SWING_SPEED = 1.6;

export interface Butt {
  group: T.Group;
  stock: Stock;
  hostile: boolean;
  /** The disc that gets shot. Raycasting against the whole group would let a
      post or a leg count as a hit. */
  face: T.Mesh;
  /** The rim ring, exposed so `world.ts` can brighten its own emissive glow
      during a hostile wind-up (see `winding`/`windUp` below) without
      reaching into `group.children` by position. */
  rim: T.Mesh;
  /** Which rank (near or far) the butt rose in — decides its depth, face
      size and the score bonus `resolveButtHit` applies. Replaces `lane` as
      what `stepButt` reads to place a butt's own z. */
  rank: Rank;
  /** Chosen once at spawn by `pickBehaviour`; read every frame by `stepButt`
      to decide how (or whether) the butt moves sideways. */
  behaviour: Behaviour;
  x: number;
  /** The x a `swing` hangs from and swings around — its spawn position,
      untouched afterward, so the arc always stays centred on the branch. */
  originX: number;
  vx: number;
  /** Elapsed time a `swing` has been swinging, feeding its own sine — kept
      separate from any other timer so pausing or resuming other behaviours
      never perturbs its phase. */
  swingT: number;
  out: number;
  rising: boolean;
  dwell: number;
  cooldown: number;
  /**
   * Whether a hostile butt is currently in the visible wind-up before it
   * looses a shot — the face turning to the player and the rim's glow
   * rising over `TELL_MS` (see `world.ts`, which owns firing and so owns
   * advancing this and `windUp` too; this file only carries the fields,
   * the same split `stepButt`'s own doc comment below describes for
   * firing itself). Always false for a non-hostile butt.
   */
  winding: boolean;
  /** Seconds elapsed in the current wind-up, 0 up to `TELL_MS / 1000`. Reset
      to 0 both when a wind-up starts and once it fires. */
  windUp: number;
  dead: number;
  /**
   * Progress through the recoil that plays when the face is struck: 0 right
   * on impact, easing to 1 (fully settled) over the animation's own
   * duration. Starts settled — nothing has hit it yet.
   */
  rock: number;
}

/**
 * Where the three rows of hedge cover sit, in world units away from the
 * camera — `scene.ts` still plants a hedge at each of these, and the
 * existing ballistics tests still fire a hostile arrow from each one, so
 * this stays as it was. It no longer decides where a *target* rises,
 * though: that is `RANKS` now, two positions (near/far) rather than three,
 * deliberately widened past this array's own middle value so the choice
 * between a safe near shot and a smaller, better-paying far one is real.
 */
export const LANES = [-12, -25, -38];
/** How near an arrow has to pass to count. Generous: this is an arcade. */
export const HIT_RADIUS = 2.6;
/**
 * The face's own radius, in local (and world, since a butt is never scaled)
 * units. This is the yardstick `ringOf` measures an impact against, so it is
 * exported rather than left as a literal buried in the geometry below.
 */
export const FACE_RADIUS = 3.4;

/** The rim/ring colour for a stock's own direction — shared by the face
    texture and anything else (a popup, say) that wants to match it. */
export function ringColourFor(hostile: boolean): string {
  return hostile ? "#ff5d5d" : "#7ae089";
}

/**
 * The hostile rim's own colour, self-lit rather than reflected.
 *
 * Under a warm, low sun the wood's whole palette leans orange — a plain
 * red material picks up that cast and drifts toward the same colour the
 * green butts do. A rim that is slightly emissive in this colour ignores
 * the light on it entirely, so a butt whose share is down today still
 * reads unmistakably red at forty units, which is the one rule in this
 * game that cannot bend.
 */
export const HOSTILE_RIM = "#ff2e2e";

/**
 * The archery-roundel bands, gold at the centre out to the rim, as fractions
 * of the face's own radius — the one source of truth both `tickerLabel`
 * (which paints its discs at these fractions, scaled to its own canvas) and
 * `ringOf` (which classifies an impact by the same numbers) read from.
 *
 * These used to be two hand-picked literals that quietly drifted apart:
 * `ringOf` classified at 0.1 / 0.3 / 0.5 / 0.7, `tickerLabel` drew at these
 * numbers here. Nothing lined up — the disc that looked gold scored only 2x,
 * and the real 3x zone, the inner tenth, was invisible, hidden entirely
 * under the ticker band drawn across the face's own centre.
 */
export const RING_FRACTIONS = [0.2656, 0.4688, 0.6406, 0.8125, 0.9844] as const;

/**
 * Which ring an impact lands in, by how far it struck from the face's own
 * centre relative to the face's own radius, against `RING_FRACTIONS` — the
 * same boundaries `tickerLabel` paints, not a separate guess at them.
 */
export function ringOf(distanceFromCentre: number, faceRadius: number): number {
  const p = faceRadius > 0 ? distanceFromCentre / faceRadius : 1;
  if (p < RING_FRACTIONS[0]) return 1; // gold
  if (p < RING_FRACTIONS[1]) return 2; // red
  if (p < RING_FRACTIONS[2]) return 3; // blue
  if (p < RING_FRACTIONS[3]) return 4; // black
  return 5; // white
}

/**
 * The traditional archery name for a ring `ringOf` returned — the same five
 * names its own inline comments already use, said out loud for the Phase 3
 * results card ("best ring: Gold"). `bestRing`'s own doc comment on
 * `Snapshot` is the source for what 0 means: nothing struck yet, so there is
 * no ring to name.
 */
export function ringName(ring: number): string {
  switch (ring) {
    case 1:
      return "Gold";
    case 2:
      return "Red";
    case 3:
      return "Blue";
    case 4:
      return "Black";
    case 5:
      return "White";
    default:
      return "—";
  }
}

/**
 * The gold is worth three of the outside. This multiplies on top of the
 * existing scoring (base points, distance bonus, combo) — it does not
 * replace any of it.
 */
export function ringMultiplier(ring: number): number {
  switch (ring) {
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 1.5;
    default:
      return 1;
  }
}

/** A hit grows the run by one; a miss ends it outright. */
export function comboAfter(hit: boolean, combo: number): number {
  return hit ? combo + 1 : 0;
}

/** The best run reached survives whatever miss just ended the current one. */
export function streakAfter(hit: boolean, combo: number, best: number): number {
  return Math.max(best, hit ? combo + 1 : combo);
}

export interface ButtHitInput {
  hostile: boolean;
  /** Which ring the arrow struck, from `ringOf`. */
  ring: number;
  /** The pre-multiplier, pre-combo points a hit on this stock is worth. */
  basePoints: number;
  /** The live combo and best-streak-so-far, both from before this hit. */
  comboBefore: number;
  streakBefore: number;
  /** The best (lowest-numbered) ring struck so far this round; 0 = none yet. */
  bestRingBefore: number;
  /**
   * The rank's own score bonus (`RANKS[rank].bonus`) — multiplies on top of
   * `ringMultiplier`, it does not replace it. Optional and defaulting to 1
   * (a near-rank hit) so every call site and test that predates ranks keeps
   * scoring exactly as it always did.
   */
  rankBonus?: number;
}

export interface ButtHitResult {
  gained: number;
  combo: number;
  streak: number;
  bestRing: number;
  /**
   * Whether the butt just struck should be destroyed.
   *
   * Every credited hit destroys its target, green or red alike — a butt
   * left standing after being credited is exactly the exploit this field
   * exists to prevent: `world.ts` re-arms `arrowTarget` from the butt's own
   * `dead`/`out` state every frame, so a live butt that survives a scored
   * hit can be scored again, and again, off a single standing target for
   * as long as it stays up — an uncapped combo multiplying every one of
   * those hits. `onArrowHit` reads this field rather than deciding
   * destruction itself, and this file's own tests exercise it directly, so
   * the two cannot silently drift apart again.
   */
  destroyButt: boolean;
}

/**
 * The scoring and lifecycle decision for one credited hit on a butt —
 * pulled out of `world.ts`'s `onArrowHit` so it is a plain function a test
 * can call directly, rather than logic only reachable by driving a live
 * `World` (which needs a real WebGL canvas this test suite has no way to
 * fake). `onArrowHit` calls this same function for the same decision.
 */
export function resolveButtHit(input: ButtHitInput): ButtHitResult {
  const multiplier = ringMultiplier(input.ring);
  const rankBonus = input.rankBonus ?? 1;
  const combo = comboAfter(true, input.comboBefore);
  const streak = streakAfter(true, input.comboBefore, input.streakBefore);
  const gained = Math.round(
    (input.hostile ? input.basePoints * 1.6 : input.basePoints) * (1 + combo * 0.08) * multiplier * rankBonus,
  );
  const bestRing = input.bestRingBefore === 0 || input.ring < input.bestRingBefore ? input.ring : input.bestRingBefore;
  return { gained, combo, streak, bestRing, destroyButt: true };
}

/**
 * Whether a butt is currently something an arrow can be steered toward or
 * credited for hitting — the exact condition `world.ts` re-arms
 * `arrowTarget` from every frame. Exported so both `world.ts` and this
 * file's own tests read the one predicate, rather than the test keeping a
 * hand-copied version of it that could silently stop matching the real one.
 */
export function isTargetable(b: Butt): boolean {
  return b.dead <= 0 && b.out > 0.15;
}

/**
 * The behaviours a target may be given, per wave — conservative at the
 * start of a round (every target simply stands) so the first stretch
 * teaches the game before anything moves or shoots back, widening to all
 * four by wave 2 so the late-round storm actually has all four in it. Waves
 * do not exist as a system yet (that is Task 4's job); this file only
 * cares about the plain number `pickBehaviour` is handed, and clamps
 * anything past wave 2 to the wave-2 pool rather than assuming more waves
 * will ever exist.
 */
const BEHAVIOURS_BY_WAVE: Behaviour[][] = [
  ["stand"],
  ["stand", "drift", "peek"],
  ["stand", "drift", "peek", "swing"],
];

/**
 * Choose a behaviour for a target about to rise. `rng` defaults to
 * `Math.random` but is a parameter so a test can pin it and assert exactly
 * which behaviour a given draw returns, rather than only ever observing
 * behaviour selection through an unseeded, untestable die roll.
 */
export function pickBehaviour(wave: number, rng: () => number = Math.random): Behaviour {
  const pool = BEHAVIOURS_BY_WAVE[Math.min(Math.max(0, Math.floor(wave)), BEHAVIOURS_BY_WAVE.length - 1)];
  return pool[Math.floor(rng() * pool.length)];
}

/** How long a destroyed butt takes to fall before it leaves the scene. */
const DEATH_FALL_TIME = 0.6;

/**
 * One frame of a butt's own motion: move sideways if its behaviour calls for
 * it, rise out of cover, dwell once fully up, and — once struck — fall away
 * and out (`retire`).
 * Pulled out of `world.ts`'s per-frame loop unchanged in behaviour, the same
 * move `resolveButtHit` and `isTargetable` already made: this is deferred
 * twice before now because nothing forced the issue, and this phase adds
 * four more behaviours to exactly this loop.
 *
 * `world.ts` still owns what a live, risen, hostile butt does *to the
 * world* — loosing an arrow needs the scene and the arrow list, neither of
 * which a butt's own motion has any business touching — so firing stays in
 * `world.ts`'s loop, called after this for whichever butts this leaves
 * live.
 */
export function stepButt(b: Butt, dt: number, bounds = 34): void {
  if (b.dead > 0) {
    // Retire: falling away after being struck, on its way out of the scene
    // once `world.ts`'s own filter sees `dead` run out.
    b.dead -= dt;
    b.group.position.y -= dt * 9;
    b.group.rotation.z += dt * 5;
    return;
  }

  // Lateral motion, switched on the behaviour chosen when the butt rose.
  // `stand` and `peek` hold their spawn x; only `drift` and `swing` move,
  // each its own way.
  if (b.behaviour === "drift") {
    // Paces along its rank, bouncing back at the edge rather than
    // wandering off it.
    b.x += b.vx * dt;
    if (b.x < -bounds || b.x > bounds) b.vx *= -1;
  } else if (b.behaviour === "swing") {
    // A shallow arc around the branch it spawned under — `originX` never
    // moves, so however long a swing hangs there it can never drift past
    // its own `SWING_AMPLITUDE`, the property "stays inside its arc" tests.
    b.swingT += dt;
    b.x = b.originX + Math.sin(b.swingT * SWING_SPEED) * SWING_AMPLITUDE;
  }

  // Rise, and dwell once fully up before sinking back into cover on its
  // own. This is also what retires a `peek`: `makeButt` pins its `dwell` to
  // `PEEK_WINDOW` rather than the usual random spread, so it ducks on
  // exactly this same timer — the same one that fires whether or not the
  // butt was ever hit, since a credited hit takes the `dead > 0` branch
  // above instead and never reaches here again.
  if (b.rising) {
    b.out = Math.min(1, b.out + dt * 2.4);
    if (b.out >= 1) {
      b.dwell -= dt;
      if (b.dwell <= 0) b.rising = false;
    }
  } else {
    b.out = Math.max(0, b.out - dt * 2.4);
  }
  // Rises from behind the hedge rather than fading in.
  b.group.position.set(b.x, -9 + b.out * 9, RANKS[b.rank].z);
  // Only a butt that is actually up and not already falling is something a
  // flying arrow should be steered toward or able to hit — the same
  // predicate `onArrowHit` reads before crediting a hit, so the two cannot
  // silently disagree about what is a live target.
  b.face.userData.arrowTarget = isTargetable(b);
}

/**
 * Apply a credited hit's lifecycle decision to the butt it struck — pulled
 * out of `world.ts`'s `onArrowHit` the way `resolveButtHit` was, so the
 * mutation itself is a plain function this file's tests can call directly
 * against the real `isTargetable` above, rather than only ever checking
 * `resolveButtHit`'s `destroyButt` field in isolation and trusting that
 * `onArrowHit` acts on it unconditionally. (It didn't, once: `if
 * (result.destroyButt && b.hostile)` shipped and left every non-hostile hit
 * standing to be farmed, and neither existing test noticed because neither
 * exercised this mutation.)
 */
export function applyButtHit(b: Butt, result: ButtHitResult): void {
  if (result.destroyButt) {
    b.dead = DEATH_FALL_TIME;
    b.rock = 0;
  }
}

export interface BestSymbolState {
  bestSymbol: string;
  bestSymbolPoints: number;
}

/**
 * Fold one hit's points into the running per-ticker total (mutating
 * `symbolPoints`, the one running tally the round keeps) and say whether
 * that ticker's cumulative total now leads the round.
 *
 * "The ticker that earned the most" means the highest total over the whole
 * round, not whichever one happened to hand back the single biggest hit —
 * pulled out of `onArrowHit` so that rule is a plain function a test can
 * call directly instead of only reading the doc comment above the field it
 * used to be inlined next to.
 */
export function bestSymbolAfter(
  symbolPoints: Map<string, number>,
  before: BestSymbolState,
  symbol: string,
  gained: number,
): BestSymbolState {
  const total = (symbolPoints.get(symbol) ?? 0) + gained;
  symbolPoints.set(symbol, total);
  if (total > before.bestSymbolPoints) return { bestSymbol: symbol, bestSymbolPoints: total };
  return before;
}

/**
 * The ticker, drawn to a texture.
 *
 * A canvas texture rather than a font loader: it needs one short string per
 * target, and shipping a typeface to render six characters would cost more
 * than the rest of the wood put together.
 */
/**
 * The face of a butt: an archery roundel with the ticker across it.
 *
 * It was a rectangle stretched onto a disc, which cropped the rings off and
 * left a pale smudge that vanished against the trees. Concentric rings in
 * the stock's own colour read as a target at any distance, and say which
 * way the share is going before the letters are legible — which matters,
 * because the red ones shoot back.
 */
export function tickerLabel(text: string, colour: string): T.Texture {
  const S = 256;
  const half = S / 2;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const c = cv.getContext("2d")!;
  // Largest first: each disc paints over the middle of the last, so what
  // ends up visible between two boundaries is whichever colour was painted
  // last for that radius — the same `RING_FRACTIONS` `ringOf` scores against.
  const rings: [number, string][] = [
    [RING_FRACTIONS[4] * half, colour],
    [RING_FRACTIONS[3] * half, "#f4edda"],
    [RING_FRACTIONS[2] * half, colour],
    [RING_FRACTIONS[1] * half, "#f4edda"],
    [RING_FRACTIONS[0] * half, "#e8b54a"],
  ];
  for (const [r, fill] of rings) {
    c.beginPath();
    c.arc(half, half, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  }
  /*
   * A band low in the disc, not across its centre.
   *
   * It used to run through the middle of the face — `fillRect(0, 104, S,
   * 48)`, covering the centre plus or minus 24px — which sat directly on
   * top of the gold ring, the one worth 3x, and hid it completely. Full
   * width is fine down here: the face is a circle, so the disc's own edge
   * clips the rectangle into a chord rather than letting it run past the
   * roundel.
   */
  const bandTop = S * 0.76;
  const bandH = S * 0.16;
  c.fillStyle = "rgba(12, 18, 24, 0.82)";
  c.fillRect(0, bandTop, S, bandH);
  c.fillStyle = "#f8f4e6";
  c.font = "bold 34px ui-monospace, SFMono-Regular, monospace";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(text.slice(0, 6), half, bandTop + bandH / 2 + 1);
  const tex = new T.CanvasTexture(cv);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

/**
 * A butt raised at a decided stock, rank, x and behaviour. The caller has
 * already decided which stock is up, which rank it rises in, where along
 * that rank it sits and how it will behave; this builds the group and the
 * rest of the state that goes with it. `behaviour` defaults to `stand` —
 * the same thing every butt did before this type existed — so a call site
 * that does not care yet (a test building a plain target, say) still gets
 * the old, simplest motion.
 */
export function makeButt(stock: Stock, rank: Rank, x: number, behaviour: Behaviour = "stand"): Butt {
  const hostile = stock.changePct < 0;
  const { z, faceScale } = RANKS[rank];
  const group = new T.Group();

  const ringColour = ringColourFor(hostile);
  // The butt: a straw roundel on a post, facing the shooter. The far rank's
  // face is drawn (and later hit-tested — see `onArrowHit` in world.ts,
  // which scores against this same `faceScale`) at half the near rank's
  // size, so a far shot is genuinely smaller to land, not just worth more.
  const face = new T.Mesh(
    new T.CircleGeometry(FACE_RADIUS * faceScale, 22),
    // Unlit: a target you cannot read is not a target, and the range is
    // lit for dusk. Both sides, so one that spawns turned slightly away is
    // still something to shoot rather than an invisible edge.
    new T.MeshBasicMaterial({
      map: tickerLabel(stock.symbol, ringColour),
      side: T.DoubleSide,
    }),
  );
  /*
   * High enough to clear the hedge it hides behind.
   *
   * At the old height the bottom half of every face sat inside the cover
   * permanently, so a target was a crescent you could not read the ticker
   * on. Cover should hide a butt while it is down and let it stand clear
   * when it is up — not crop it forever.
   */
  face.position.y = 5.2;
  group.add(face);

  const rim = new T.Mesh(
    // Scaled the same as the face, so a far rim doesn't sit proud of a
    // face half its own size.
    new T.TorusGeometry(3.45 * faceScale, 0.24 * faceScale, 6, 24),
    new T.MeshLambertMaterial({
      color: new T.Color(ringColour),
      // Emissive only for the hostile rim: self-lit red does not take the
      // sun's warm tint the way a reflective colour would, so it still
      // reads as red rather than orange from a distance. 1.1 ran five to
      // ten times brighter than anything else in the scene and read as a
      // glowing ring rather than a target that happens to be red; 0.4 is
      // enough to hold its colour without blowing out.
      emissive: hostile ? new T.Color(HOSTILE_RIM) : 0x000000,
      emissiveIntensity: hostile ? 0.4 : 0,
      flatShading: true,
    }),
  );
  rim.position.y = 5.2;
  group.add(rim);

  const post = new T.Mesh(
    new T.CylinderGeometry(0.18, 0.24, 5.4, 5),
    new T.MeshLambertMaterial({ color: 0x4a3a28, flatShading: true }),
  );
  post.position.y = 2.7;
  group.add(post);

  // The butt casts its own shadow — the rim and post are what tell the eye
  // it stands proud of the hedge behind it under a low, raking sun.
  group.traverse((o) => {
    if (o instanceof T.Mesh) o.castShadow = true;
  });

  group.position.set(x, -9, z);

  return {
    group,
    stock,
    hostile,
    face,
    rim,
    rank,
    behaviour,
    x,
    originX: x,
    vx: (Math.random() < 0.5 ? 1 : -1) * rand(1.6, 4.2),
    swingT: 0,
    out: 0,
    rising: true,
    /*
     * A red that never fires is scenery.
     *
     * The first shot was on a 0.6-1.3s timer while a butt stood up for only
     * 0.4-1.1s, so most of them sank back into cover without ever loosing —
     * which is why the reds seemed harmless. They now stand long enough to
     * shoot, and shoot soon enough to matter.
     *
     * A `peek` overrides this to a fixed `PEEK_WINDOW` instead: "rises for
     * 1.8 seconds and drops" means exactly that duration, not the usual
     * random spread.
     */
    dwell: behaviour === "peek" ? PEEK_WINDOW : hostile ? rand(1.3, 2.4) : rand(0.5, 1.2),
    cooldown: hostile ? rand(0.25, 0.6) : rand(0.6, 1.3),
    winding: false,
    windUp: 0,
    dead: 0,
    rock: 1,
  };
}

/**
 * Free a retired butt's GPU-side resources: not just the face's geometry,
 * but its material and the 256x256 ticker texture on it, and the rim and
 * post's own geometry and material besides.
 *
 * Retirement used to dispose the face geometry alone, and only on one of the
 * two paths a butt leaves the scene by — the fall after being struck, never
 * the duck back into cover. At 100-150 butts a round that is tens of
 * megabytes of texture a round, never freed; `renderer.dispose()` in
 * `world.ts`'s `stop()` does not touch any of it. Walking `b.group`'s own
 * children rather than naming `face`/`rim`/`post` individually means a
 * fourth mesh added to a butt later is disposed here for free.
 */
export function disposeButt(b: Butt): void {
  for (const child of b.group.children) {
    if (!(child instanceof T.Mesh)) continue;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of materials) {
      (m as T.MeshBasicMaterial).map?.dispose();
      m.dispose();
    }
  }
}
