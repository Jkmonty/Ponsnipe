import * as T from "three";
import type { Stock } from "./world";
import { rand } from "./rand";

export interface Butt {
  group: T.Group;
  stock: Stock;
  hostile: boolean;
  /** The disc that gets shot. Raycasting against the whole group would let a
      post or a leg count as a hit. */
  face: T.Mesh;
  lane: number;
  x: number;
  vx: number;
  out: number;
  rising: boolean;
  dwell: number;
  cooldown: number;
  dead: number;
  /**
   * Progress through the recoil that plays when the face is struck: 0 right
   * on impact, easing to 1 (fully settled) over the animation's own
   * duration. Starts settled — nothing has hit it yet.
   */
  rock: number;
}

/** Where the three rows of cover sit, in world units away from the camera. */
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
  const combo = comboAfter(true, input.comboBefore);
  const streak = streakAfter(true, input.comboBefore, input.streakBefore);
  const gained = Math.round(
    (input.hostile ? input.basePoints * 1.6 : input.basePoints) * (1 + combo * 0.08) * multiplier,
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

/** How long a destroyed butt takes to fall before it leaves the scene. */
const DEATH_FALL_TIME = 0.6;

/**
 * One frame of a butt's own motion: drift along its lane, rise out of cover,
 * dwell once fully up, and — once struck — fall away and out (`retire`).
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

  // Drift: paces along its lane, bouncing back at the edge rather than
  // wandering off it.
  b.x += b.vx * dt;
  if (b.x < -bounds || b.x > bounds) b.vx *= -1;

  // Rise, and dwell once fully up before sinking back into cover on its own.
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
  b.group.position.set(b.x, -9 + b.out * 9, LANES[b.lane]);
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
 * A butt raised at a decided stock, lane and x. The caller has already
 * decided which stock is up, which lane it rises in and where along that
 * lane it sits; this builds the group and the rest of the state that goes
 * with it.
 */
export function makeButt(stock: Stock, lane: number, x: number): Butt {
  const hostile = stock.changePct < 0;
  const z = LANES[lane];
  const group = new T.Group();

  const ringColour = ringColourFor(hostile);
  // The butt: a straw roundel on a post, facing the shooter.
  const face = new T.Mesh(
    new T.CircleGeometry(FACE_RADIUS, 22),
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
    new T.TorusGeometry(3.45, 0.24, 6, 24),
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
    lane,
    x,
    vx: (Math.random() < 0.5 ? 1 : -1) * rand(1.6, 4.2),
    out: 0,
    rising: true,
    /*
     * A red that never fires is scenery.
     *
     * The first shot was on a 0.6-1.3s timer while a butt stood up for only
     * 0.4-1.1s, so most of them sank back into cover without ever loosing —
     * which is why the reds seemed harmless. They now stand long enough to
     * shoot, and shoot soon enough to matter.
     */
    dwell: hostile ? rand(1.3, 2.4) : rand(0.5, 1.2),
    cooldown: hostile ? rand(0.25, 0.6) : rand(0.6, 1.3),
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
