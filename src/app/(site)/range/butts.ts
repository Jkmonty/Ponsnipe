import * as T from "three";
import type { Stock } from "./world";
import { rand } from "./rand";
import { ballisticElevation, SHOT_SPEED } from "./arrows";

/**
 * The four ways a target can hold itself up, chosen once when it rises
 * (`pickBehaviour`) and read every frame after by `stepButt`, switched on
 * `b.behaviour`:
 *
 * - `stand`: rises and stays, as every butt used to.
 * - `drift`: tracks sideways along its rank, bouncing back at the edge —
 *   the motion every butt had unconditionally before this type existed.
 * - `peek`: rises for `peekWindow` seconds and drops, whether hit or not.
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

/**
 * Where the shooting line stands, in z — `world.ts` puts the camera here.
 *
 * It lives beside `RANKS` because the gap between this line and a rank's own
 * z is what decides how long an arrow spends in the air reaching that rank,
 * and that is what decides how long a butt standing there has to stay up.
 */
export const SHOOTER_Z = 20;

/**
 * How far either side of centre a butt may rise: `world.ts`'s spawner draws
 * its x from exactly this. The far corner of that spread, not the middle of
 * it, is the shot a rank has to be able to answer — a butt that comes up at
 * the edge of its rank is as ordinary as one that comes up in front of you.
 */
export const SPAWN_X_LIMIT = 30;

/**
 * How high a butt's face and rim stand above the ground it rises from — the
 * height `makeButt` builds them at, and the height an arrow has to climb to.
 */
export const FACE_HEIGHT = 5.2;

/**
 * How high the nock sits when a shot leaves it. `world.ts` puts the eye at
 * y 3.6 and hangs the nock 0.2 below it; a traced shot leaves at 3.43, the
 * few hundredths being the pitch of the view.
 */
export const NOCK_HEIGHT = 3.4;

/**
 * The longest horizontal shot a butt of `rank` can ask for: `SPAWN_X_LIMIT`
 * out to the side and the whole depth from `SHOOTER_Z` to the rank's own z.
 * 51.6 units at the near rank, 67.1 at the far.
 */
export function longestShotTo(rank: Rank): number {
  return Math.hypot(SPAWN_X_LIMIT, SHOOTER_Z - RANKS[rank].z);
}

/**
 * How long the one shot this game looses spends in the air reaching the far
 * corner of `rank` — 1.05 seconds at the near rank, 1.37 at the far.
 *
 * The worst case of the spread and not its average, because a dwell derived
 * from the average leaves every butt past the middle of its rank unhittable,
 * which is the same defect in a smaller size.
 *
 * `ballisticElevation` is the solver `World.fire` actually launches at, so
 * the horizontal component here is the one the arrow really flies at: the
 * shot leaves 8.0 degrees above the flat at the near rank and 9.3 at the
 * far, and dividing by the cosine of that is the whole difference between
 * this and range over speed.
 */
export function flightTimeTo(rank: Rank): number {
  const range = longestShotTo(rank);
  const elevation = ballisticElevation(range, FACE_HEIGHT - NOCK_HEIGHT, SHOT_SPEED);
  return range / (SHOT_SPEED * Math.cos(elevation));
}

/**
 * How long a target has to be up before the arrow is even loosed.
 *
 * The player has to see it clear the hedge, decide it is worth a shot and
 * put the reticle on it — and if they have just loosed at something else
 * they cannot answer at all until the nock refills, which is `NOCK_TIME`
 * (0.42s) in world.ts. A quarter of a second to notice plus that refill is
 * 0.67; 0.8 is that with a little left to swing the view across a rank
 * sixty units wide.
 *
 * This is the one number in this group that is chosen rather than derived.
 * Everything it is added to is measured: `flightTimeTo` is a different
 * number at each rank, which is the whole reason one shared dwell could
 * never have been right for both of them.
 */
export const AIM_WINDOW = 0.8;

/**
 * The floor under every dwell at `rank` — react, then fly. 1.85 seconds at
 * the near rank, 2.17 at the far.
 *
 * A dwell shorter than this cannot be answered at all in the worst case of
 * its own rank's spread, and all three dwells were shorter than this. A
 * green butt was given 0.5 to 1.2 seconds against the far rank's 1.37s
 * flight, so a far green was never hittable at any x and a near one was a
 * coin toss. Those numbers were set when a click was an instant raycast and
 * a target only had to be up at the moment you clicked; nothing revisited
 * them when arrows were given travel time.
 */
export function minimumDwell(rank: Rank): number {
  return AIM_WINDOW + flightTimeTo(rank);
}

/**
 * How long a `peek` stays fully up before it drops on its own — hit or not.
 *
 * Exactly `minimumDwell`, which makes it the tightest of the three dwells by
 * construction: the fleeting target gets the reaction and the flight and not
 * one tenth of a second more, at whichever rank it rose in.
 *
 * It was a flat 1.8 seconds for both ranks — within a twentieth of a second
 * of what the near rank needs, and a third of a second short of the far
 * rank, where it left about four tenths of a second to see the target,
 * decide and click. The behaviour's identity is unchanged ("rises, and drops
 * whether hit or not"); what changes is that the window is measured against
 * the flight to the rank it rose in.
 */
export function peekWindow(rank: Rank): number {
  return minimumDwell(rank);
}

/** How much longer than `minimumDwell` a green butt may stand: the same 0.7
    seconds of spread its whole dwell used to be (`rand(0.5, 1.2)`). */
export const GREEN_SPREAD = 0.7;

/** And a red one: the same 1.1 seconds of spread its whole dwell used to be
    (`rand(1.3, 2.4)`), the widest of the three, because destroying a red
    butt is how you stop it shooting you and it cannot be destroyed if it is
    already back in cover when the arrow arrives. */
export const HOSTILE_SPREAD = 1.1;

/**
 * How long a butt of this rank, colour and behaviour stays fully up.
 *
 * All three start at `minimumDwell(rank)` — a target that is up must stay up
 * long enough to be shot *and hit*, at its own rank — and differ only in how
 * far past that they may run: a `peek` not at all, a green butt by up to
 * `GREEN_SPREAD`, a red one by up to `HOSTILE_SPREAD`. Each spread is the
 * width the old hand-picked range had, so the three keep the character they
 * were given; it is the floor they sit on that is now derived from how long
 * an arrow takes to get there.
 *
 * `rand` rather than an inline `Math.random` for the same reason everything
 * else here uses it: a test that pins `Math.random` to 0 gets the shortest
 * dwell of the spread, which is the case worth pinning.
 */
export function dwellFor(rank: Rank, hostile: boolean, behaviour: Behaviour): number {
  if (behaviour === "peek") return peekWindow(rank);
  return minimumDwell(rank) + rand(0, hostile ? HOSTILE_SPREAD : GREEN_SPREAD);
}

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
   * exists to prevent: `stepButt` re-arms `arrowTarget` from the butt's own
   * `dead`/`out` state every frame, so a live butt that survives a scored
   * hit can be scored again, and again, off a single standing target for
   * as long as it stays up — an uncapped combo multiplying every one of
   * those hits. `onArrowHit` reads this field rather than deciding
   * destruction itself, and this file's own tests exercise it directly, so
   * the two cannot silently drift apart again.
   *
   * Destruction is what makes that safe, and it is the whole of what makes
   * it safe: `onArrowHit` does not consult `isTargetable` before crediting
   * a hit. It credits whatever face the raycast in `stepArrows` handed it,
   * and that raycast reads `face.userData.arrowTarget`. So the flag being
   * honest on every frame, including the frames a struck butt spends
   * falling, is load-bearing rather than tidy. It was not, once — see
   * `stepButt`'s death branch, which used to return before re-arming it.
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
 * credited for hitting — the exact condition `stepButt` re-arms
 * `face.userData.arrowTarget` from, on every frame and on every path
 * through it, the death branch included. Exported so `world.ts`, this file
 * and its tests all read the one predicate rather than keeping hand-copied
 * versions that could quietly stop matching.
 *
 * `dead === 0`, not `dead <= 0`: `dead` counts a fall down from
 * `DEATH_FALL_TIME` and goes negative on the last frame before `world.ts`
 * takes the butt out of the scene, so `<=` called a corpse a live target
 * again on exactly that frame. Only a butt that has never been struck is
 * one.
 */
export function isTargetable(b: Butt): boolean {
  return b.dead === 0 && b.out > 0.15;
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
    // The same re-arming the live path does at the bottom of this function,
    // and the reason it is repeated here rather than left to fall through:
    // this branch returns, so for the whole 0.6s of the fall the flag kept
    // whatever it last said — `true` — while `isTargetable` said false. A
    // destroyed butt stayed a scoring target the entire way down, because
    // `stepArrows` raycasts the flag and nothing reads the predicate. That
    // is the one case where the two could disagree, and it was the only
    // case that mattered.
    b.face.userData.arrowTarget = isTargetable(b);
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
  // own. This is also what retires a `peek`: `dwellFor` pins its `dwell` to
  // `peekWindow` rather than adding a random spread on top of the floor, so
  // it ducks on exactly this same timer — the same one that fires whether or
  // not the butt was ever hit, since a credited hit takes the `dead > 0`
  // branch above instead and never reaches here again.
  //
  // The clock only starts once `out` reaches 1, which is what makes `dwell`
  // the time a butt is *fully* up rather than the time it is in the scene:
  // the 0.42s climb out of cover is on top of it. Every one of the numbers
  // `dwellFor` hands out is longer than the flight time to the rank the butt
  // rose in, so what counts down here always outlasts an arrow aimed at it.
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
  // flying arrow should be steered toward or able to hit. `onArrowHit` does
  // *not* check this predicate itself — it credits whatever face the
  // raycast handed it — so this flag is the only thing standing between a
  // butt and being scored, and it has to be re-armed on every path through
  // this function, not only this one. The death branch above does the same.
  b.face.userData.arrowTarget = isTargetable(b);
}

/**
 * How fast a butt is moving sideways, right now — the horizontal counterpart
 * of `ballisticElevation`'s vertical solve, and what `World.fire` reads to
 * lead a moving target rather than aiming at wherever its face stood the
 * instant the reticle found it.
 *
 * Exported as a function of the butt's own state rather than left to the
 * caller differencing two frames' positions: a difference lags a whole frame
 * behind and would get the sign wrong on the exact frame a `drift` bounces
 * off `bounds` in `stepButt`, which is the one moment a stale velocity would
 * matter most.
 *
 * `stand` and `peek` never move sideways, so this is 0 for both — read
 * straight off `stepButt`'s own branches, not asserted separately. `drift`
 * moves at the constant `b.vx` `stepButt` already steps `b.x` by. `swing`
 * traces `b.originX + sin(b.swingT * SWING_SPEED) * SWING_AMPLITUDE` (see
 * `stepButt`); this is that expression's own derivative with respect to
 * time, `SWING_AMPLITUDE * SWING_SPEED * cos(b.swingT * SWING_SPEED)`.
 */
export function lateralVelocity(b: Butt): number {
  switch (b.behaviour) {
    case "drift":
      return b.vx;
    case "swing":
      return SWING_AMPLITUDE * SWING_SPEED * Math.cos(b.swingT * SWING_SPEED);
    default:
      return 0;
  }
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
  face.position.y = FACE_HEIGHT;
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
  rim.position.y = FACE_HEIGHT;
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
     * How long it stands fully up once it is clear of cover — see `dwellFor`
     * above, which is where the three cases and the arithmetic behind them
     * live.
     *
     * Two separate things have to be true of this number and only the first
     * ever was. A red that never fires is scenery: its first shot waits on a
     * 0.25-0.6s cooldown and then a 900ms wind-up, so a butt that stood up
     * for the 0.4-1.1s this once was sank back into cover without ever
     * loosing, which is why the reds seemed harmless. And a target that
     * cannot be hit is scenery too: an arrow takes up to 1.05s to cross the
     * near rank and 1.37s to cross the far one, so a green butt on the old
     * 0.5-1.2s was back in cover before the arrow aimed at it could arrive.
     * `dwellFor` is what answers both.
     */
    dwell: dwellFor(rank, hostile, behaviour),
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
