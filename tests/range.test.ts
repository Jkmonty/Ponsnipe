import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import {
  drawSpeed,
  assistAngle,
  stepArrows,
  looseEnemyArrow,
  ballisticElevation,
  DRAW_MIN_SPEED,
  DRAW_MAX_SPEED,
  SHOT_DRAW,
  SHOT_SPEED,
  type Arrow,
} from "../src/app/(site)/range/arrows";
import {
  ringOf,
  ringMultiplier,
  ringName,
  comboAfter,
  streakAfter,
  resolveButtHit,
  isTargetable,
  applyButtHit,
  bestSymbolAfter,
  LANES,
  RING_FRACTIONS,
  FACE_RADIUS,
  makeButt,
  stepButt,
  pickBehaviour,
  RANKS,
  peekWindow,
  minimumDwell,
  flightTimeTo,
  longestShotTo,
  dwellFor,
  AIM_WINDOW,
  GREEN_SPREAD,
  HOSTILE_SPREAD,
  SHOOTER_Z,
  SPAWN_X_LIMIT,
  FACE_HEIGHT,
  NOCK_HEIGHT,
  SWING_AMPLITUDE,
  type Behaviour,
  type Rank,
  type Butt,
} from "../src/app/(site)/range/butts";
import {
  nockReady,
  World,
  TELL_MS,
  endingGate,
  accuracyPct,
  SLOW_MOTION_SCALE,
  FINAL_STRETCH_MS,
  ENDING_MAX_S,
  DEATH_BEAT_S,
  ROUND_MS,
  type Snapshot,
} from "../src/app/(site)/range/world";
import {
  shareLines,
  shareText,
  SKY_STOPS,
  SAMPLED_AGAINST,
  HAZE,
  SUN,
  rgbTriplet,
  type Run,
} from "../src/app/(site)/range/share";
import {
  SKY_TOP,
  SKY_MID,
  SKY_HOT,
  SKY_HORIZON,
  FOG_COLOUR,
  SUN_COLOUR,
  GROUND_ALBEDO,
  OAK_LEAF_ALBEDO,
  PALISADE_ALBEDO,
  SUN_ANGLE_DEG,
} from "../src/app/(site)/range/scene";
import { makeNullSurface } from "../src/app/(site)/range/render";
import { waveAt } from "../src/app/(site)/range/waves";
import { musicRateForWave } from "../src/app/(site)/range/sfx";

/*
 * `World.attract()` starts its render loop the same way a browser round
 * does, via `requestAnimationFrame` — Node has no such global. The
 * acceptance test below drives every frame itself through the real
 * `step()`, so the scheduled callback this never fires is not needed; it
 * only has to exist so `attract()` does not throw building it.
 */
globalThis.requestAnimationFrame ??= (() => 0) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= (() => {}) as typeof cancelAnimationFrame;

/*
 * Attract mode spawns real butts, red and green alike — the wood is alive
 * before Start and draws from the whole day, not the green half of it —
 * and building one bakes its ticker onto a canvas texture (`tickerLabel`
 * in butts.ts), which needs a working `document.createElement("canvas")`.
 * This is bare 2D context plumbing so that real drawing can run without
 * throwing; it decides nothing the game decides, the same way the rAF
 * stand-in above only stands in for the browser's scheduler, not for
 * `step` itself.
 */
if (typeof document === "undefined") {
  const context2d = {
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    rect() {},
    fill() {},
    stroke() {},
    fillRect() {},
    fillText() {},
    measureText: (s: string) => ({ width: s.length * 8 }) as TextMetrics,
  } as unknown as CanvasRenderingContext2D;
  (globalThis as unknown as { document: Pick<Document, "createElement"> }).document = {
    createElement: (tag: string) =>
      ({
        width: 0,
        height: 0,
        getContext: () => context2d,
      }) as unknown as HTMLCanvasElement,
  } as Pick<Document, "createElement"> as Document;
}

/** A bare arrow mesh — nothing from arrows.ts is needed to build one for a test. */
function makeTestArrow(overrides: Partial<Arrow> & { vel: T.Vector3 }): Arrow {
  const mesh = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 1.1, 5), new T.MeshBasicMaterial());
  return { mesh, life: 6, mine: true, stuck: 0, spin: 0, ...overrides };
}

test("a full draw is the fast arrow and the minimum is the slow one", () => {
  assert.equal(drawSpeed(1), DRAW_MAX_SPEED);
  assert.equal(drawSpeed(0), DRAW_MIN_SPEED);
});

test("half a draw is half the difference, not half the speed", () => {
  assert.equal(drawSpeed(0.5), (DRAW_MIN_SPEED + DRAW_MAX_SPEED) / 2);
});

test("a draw outside 0..1 cannot loose a faster or slower arrow than the limits", () => {
  assert.equal(drawSpeed(1.6), DRAW_MAX_SPEED);
  assert.equal(drawSpeed(-0.4), DRAW_MIN_SPEED);
});

test("a thumb gets more help than a mouse, and both are small", () => {
  const mouse = assistAngle(false);
  const touch = assistAngle(true);
  assert.ok(touch > mouse, "touch should be forgiven more");
  assert.equal(touch, mouse * 1.5);
  // The point is not a specific number of degrees, it is that a genuinely
  // wide shot still misses: an arcade reticle, not an aimbot.
  assert.ok(touch < 0.0785, "assist must stay small enough that a wide shot still misses");
});

test("gravity pulls a level shot down, and quadratically, not linearly", () => {
  const scene = new T.Scene(); // no targets, no ground: nothing to collide with, just flight
  const arrow = makeTestArrow({ vel: new T.Vector3(0, 0, -drawSpeed(1)), mine: false, life: 100 });
  scene.add(arrow.mesh);
  const startY = arrow.mesh.position.y;

  const dt = 1 / 60;
  const oneSecond = 60;
  for (let i = 0; i < oneSecond; i++) stepArrows([arrow], dt, scene, () => {});
  const dropAtT = startY - arrow.mesh.position.y;

  for (let i = 0; i < oneSecond; i++) stepArrows([arrow], dt, scene, () => {}); // now at 2T
  const dropAt2T = startY - arrow.mesh.position.y;

  assert.ok(dropAtT > 0, "a level shot should have fallen at all by T");
  // Free fall from rest covers 4x the distance in 2x the time (y ∝ t²), not
  // 2x — that is the signature that would tell gravity apart from a constant
  // downward nudge. Banded rather than exact to allow for the step
  // integrator's own discretisation error.
  const ratio = dropAt2T / dropAtT;
  assert.ok(ratio > 3.7 && ratio < 4.3, `expected roughly 4x the drop in 2x the time, got ${ratio}`);
});

test("a fast arrow on a long frame cannot tunnel through a small face between its start and end", () => {
  const scene = new T.Scene();
  const face = new T.Mesh(new T.CircleGeometry(1, 16), new T.MeshBasicMaterial({ side: T.DoubleSide }));
  // Sitting well short of where a whole frame's travel would end, so only a
  // check of the swept segment - not a check of the endpoint, and not a
  // check of the start point - can find it.
  face.position.set(0, 0, -1.8);
  face.userData.arrowTarget = true;
  scene.add(face);

  const dt = 1 / 15; // a long frame: dropped frames, a slow device, a tab that stalled
  const speed = drawSpeed(1); // DRAW_MAX_SPEED
  const travelled = speed * dt;
  assert.ok(travelled > 3, "the arrow should travel well past the face in one frame");
  const distToFaceCentre = 1.8;
  assert.ok(
    travelled - distToFaceCentre > face.geometry.parameters.radius,
    "the end of the frame's travel must land clear of the face - otherwise an end-point check would pass by accident",
  );

  const arrow = makeTestArrow({ vel: new T.Vector3(0, 0, -speed), mine: false, life: 6 });
  scene.add(arrow.mesh);

  let hit: T.Object3D | null = null;
  stepArrows([arrow], dt, scene, (_a, h) => {
    hit = h;
  });

  assert.equal(hit, face, "the swept segment should have caught the face the endpoint flew past");
});

test("the arrow cap trims the oldest first, from both the array and the scene", () => {
  const scene = new T.Scene();
  const arrows: Arrow[] = [];
  for (let i = 0; i < 25; i++) {
    const a = makeTestArrow({ vel: new T.Vector3(0, 0, -1), mine: false, life: 100 });
    a.mesh.userData.idx = i;
    scene.add(a.mesh);
    arrows.push(a);
  }
  const oldest = arrows[0];
  const disposed = { geometry: false, material: false };
  oldest.mesh.geometry.addEventListener("dispose", () => (disposed.geometry = true));
  (oldest.mesh.material as T.Material).addEventListener("dispose", () => (disposed.material = true));

  stepArrows(arrows, 1 / 60, scene, () => {});

  assert.equal(arrows.length, 24, "one over the cap should be trimmed");
  assert.ok(!arrows.includes(oldest), "the trimmed arrow should be the oldest one");
  assert.equal(arrows[0].mesh.userData.idx, 1, "the next-oldest should now be at the front");
  assert.ok(!scene.children.includes(oldest.mesh), "the trimmed arrow's mesh must leave the scene too");
  assert.ok(disposed.geometry && disposed.material, "its geometry and material should be freed, not leaked");
});

test("a stuck arrow fades out and is eventually swept up", () => {
  const scene = new T.Scene();
  const arrow = makeTestArrow({ vel: new T.Vector3(0, 0, 0), mine: true, life: 6, stuck: 0.01 });
  scene.add(arrow.mesh);
  const arrows: Arrow[] = [arrow];

  // Well past the three seconds a stuck arrow is documented to linger for.
  for (let i = 0; i < 10 && arrows.length; i++) stepArrows(arrows, 0.5, scene, () => {});

  assert.equal(arrows.length, 0, "a long-stuck arrow should have been removed");
  assert.ok(!scene.children.includes(arrow.mesh), "and taken out of the scene");
});

test("two arrows landing on the same face in one tick score only once", () => {
  const scene = new T.Scene();
  const face = new T.Mesh(new T.CircleGeometry(3.4, 16));
  face.position.set(0, 0, -5);
  face.userData.arrowTarget = true;
  scene.add(face);

  const a1 = makeTestArrow({ vel: new T.Vector3(0, 0, -50), mine: true });
  const a2 = makeTestArrow({ vel: new T.Vector3(0, 0, -50), mine: true });
  scene.add(a1.mesh);
  scene.add(a2.mesh);

  let hits = 0;
  stepArrows([a1, a2], 1 / 10, scene, () => {
    hits += 1;
  });

  assert.equal(hits, 1, "the second arrow must not score a butt the first already killed this tick");
  assert.ok(a1.stuck > 0 && a2.stuck > 0, "both arrows still physically land, only one is credited");
});

test("a touch-fired arrow is steered by the wider cone; a mouse-fired one at the same angle is not", () => {
  const scene = new T.Scene();
  const mouseCone = assistAngle(false);
  const touchCone = assistAngle(true);
  // Strictly between the two: outside the mouse assist cone, inside the touch one.
  const theta = (mouseCone + touchCone) / 2;

  // A target off to one side, positioned so the angle from a straight shot
  // to it is exactly `theta` — the one angle that tells the two cones apart.
  const distance = 50;
  const face = new T.Mesh(new T.CircleGeometry(2, 16), new T.MeshBasicMaterial());
  face.position.set(distance * Math.tan(theta), 0, -distance);
  face.userData.arrowTarget = true;
  scene.add(face);

  const speed = 40;
  const mouseArrow = makeTestArrow({ vel: new T.Vector3(0, 0, -speed), mine: true, touch: false });
  const touchArrow = makeTestArrow({ vel: new T.Vector3(0, 0, -speed), mine: true, touch: true });
  scene.add(mouseArrow.mesh);
  scene.add(touchArrow.mesh);

  const dt = 1 / 60;
  for (let i = 0; i < 5; i++) {
    stepArrows([mouseArrow], dt, scene, () => {});
    stepArrows([touchArrow], dt, scene, () => {});
  }

  // Steering only ever nudges sideways (toward the target's +x offset) — gravity
  // is the only other thing touching velocity, and it only ever touches y.
  assert.equal(mouseArrow.vel.x, 0, "outside its narrower cone, the mouse shot must fly dead straight");
  assert.ok(touchArrow.vel.x > 0, "inside its wider cone, the touch shot should be pulled toward the target");
});

test("the rings run gold, red, blue, black, white from the centre out, matching RING_FRACTIONS — the same numbers tickerLabel paints from", () => {
  const r = 10;
  const [f1, f2, f3, f4] = RING_FRACTIONS;
  assert.equal(ringOf(0, r), 1);
  assert.equal(ringOf(((f1 + f2) / 2) * r, r), 2);
  assert.equal(ringOf(((f2 + f3) / 2) * r, r), 3);
  assert.equal(ringOf(((f3 + f4) / 2) * r, r), 4);
  assert.equal(ringOf(r, r), 5, "at the rim, beyond the outermost drawn ring");
});

test("a hit just inside a RING_FRACTIONS boundary scores one ring better than a hit just outside it", () => {
  const r = 10;
  // Only the first four fractions are boundaries `ringOf` actually compares
  // against — the fifth is the outer edge tickerLabel paints to, with
  // everything beyond it (out to the rim and past) falling to the same
  // catch-all outermost ring, so there is no fifth step to find.
  for (const f of RING_FRACTIONS.slice(0, 4)) {
    const justInside = ringOf(f * r - 0.001 * r, r);
    const justOutside = ringOf(f * r + 0.001 * r, r);
    assert.equal(justOutside, justInside + 1, `the boundary at ${f} should be where the ring number steps`);
  }
});

test("the gold is worth three of the outside", () => {
  assert.equal(ringMultiplier(1), 3);
  assert.equal(ringMultiplier(5), 1);
  assert.ok(ringMultiplier(1) > ringMultiplier(2));
});

test("a miss resets the combo and a hit grows it", () => {
  assert.equal(comboAfter(true, 0), 1);
  assert.equal(comboAfter(true, 4), 5);
  assert.equal(comboAfter(false, 9), 0);
});

test("the best streak survives the miss that ended it", () => {
  assert.equal(streakAfter(true, 4, 3), 5);
  assert.equal(streakAfter(false, 9, 9), 9);
  assert.equal(streakAfter(true, 1, 6), 6);
});

/*
 * `resolveButtHit` is the exact decision `onArrowHit` reads to decide
 * whether the butt it just scored gets destroyed — not a parallel copy of
 * it. A round-1 regression let a non-hostile hit leave the butt standing
 * (only `b.hostile` was destroyed); because `world.ts` re-arms a butt's
 * `arrowTarget` from its own `dead`/`out` state every frame, a standing
 * butt could be scored again by every arrow for the rest of its time up —
 * an uncapped combo farmed off one target. These two tests exercise the
 * real hit-resolution path (not just the pure ring/combo maths above) and
 * would fail the instant that destroy decision stops applying uniformly.
 */
test("a credited hit destroys its target, green or red alike — a standing butt cannot be farmed for an uncapped combo", () => {
  const green = resolveButtHit({ hostile: false, ring: 3, basePoints: 100, comboBefore: 0, streakBefore: 0, bestRingBefore: 0 });
  const red = resolveButtHit({ hostile: true, ring: 3, basePoints: 100, comboBefore: 0, streakBefore: 0, bestRingBefore: 0 });
  assert.equal(green.destroyButt, true, "a green butt left standing after being credited can be scored again for free");
  assert.equal(red.destroyButt, true);
});

/*
 * The whole-branch review found that neither of the two tests above ever
 * executes the real hit path: one calls only `resolveButtHit`, the other
 * (until this change) defined its own local copy of `isTargetable` instead
 * of importing the real one from butts.ts. Change world.ts's hit handler to
 * `if (result.destroyButt && b.hostile)` — the exact defect that shipped
 * last round, which left every non-hostile credited hit standing to be
 * farmed — and both of the tests above still pass, because neither one ever
 * calls `applyButtHit` or checks the real `isTargetable` against a real
 * `Butt`. This test does both, on a green (non-hostile) butt, so it fails
 * the instant destruction stops applying uniformly.
 *
 * Built by hand rather than via `makeButt`: `makeButt` calls `tickerLabel`,
 * which needs a real DOM `document` to render a canvas texture — the same
 * reason `onArrowHit` itself (which also spawns a canvas-texture popup)
 * cannot be driven directly in this test runner. `isTargetable` and
 * `applyButtHit` only ever read `dead`, `out`, `rock` and `hostile`, so a
 * plain object carrying just those is the real functions under real data,
 * not a reimplementation of them.
 */
test("applyButtHit and the real isTargetable are the hit path — a credited hit on a GREEN butt takes it out of play too", () => {
  const butt = { hostile: false, dead: 0, out: 1, rock: 1 } as unknown as import("../src/app/(site)/range/butts").Butt;
  assert.equal(butt.hostile, false);
  assert.equal(isTargetable(butt), true, "an unstruck, fully-risen butt should be a valid target");

  const result = resolveButtHit({
    hostile: butt.hostile,
    ring: 5,
    basePoints: 100,
    comboBefore: 3,
    streakBefore: 3,
    bestRingBefore: 2,
  });
  assert.equal(result.destroyButt, true);

  applyButtHit(butt, result);

  assert.equal(
    isTargetable(butt),
    false,
    "a credited hit must take the target out of play, or every later arrow this round scores off the same standing butt",
  );
});

/*
 * The other half of that, and the half that was wrong: `isTargetable` is
 * not what `onArrowHit` consults. It credits whatever face the raycast in
 * `stepArrows` handed it, and that raycast reads
 * `face.userData.arrowTarget`. So the flag is the real gate, and the only
 * state in which it could disagree with the predicate is a *dead* butt —
 * `stepButt`'s death branch used to return before re-arming it, leaving a
 * destroyed butt a scoring target for the whole 0.6s of its fall, on a
 * board that pays a prize and with the far rank's bonus doubling what a
 * re-credit is worth.
 *
 * So the assertion is the relationship, checked on every frame of the fall
 * and one frame past the end of it: the flag says exactly what
 * `isTargetable` says. A butt still up is checked too, so that "they always
 * agree" cannot be satisfied by a flag that is simply always false.
 *
 * Built through the real `makeButt`/`stepButt`, since the flag lives on a
 * real `face` and re-arming it is `stepButt`'s own job.
 */
test("a dead butt's arrowTarget flag says what isTargetable says, on every frame of the fall", () => {
  const dt = 1 / 60;
  const b = makeButt({ symbol: "GRN", changePct: 2 }, "near", 0, "stand");
  b.out = 1;
  b.rising = true;
  b.dwell = 10;

  stepButt(b, dt);
  assert.equal(
    !!b.face.userData.arrowTarget,
    isTargetable(b),
    "a risen, unstruck butt: the flag and the predicate agree, and both say yes",
  );
  assert.equal(isTargetable(b), true, "and it really is a target, or the rest of this proves nothing");

  applyButtHit(
    b,
    resolveButtHit({ hostile: false, ring: 1, basePoints: 40, comboBefore: 0, streakBefore: 0, bestRingBefore: 0 }),
  );

  let frames = 0;
  // One frame past `dead` running out, which is where `world.ts` takes the
  // butt out of the scene — and where a `dead <= 0` predicate used to call
  // a corpse a live target again.
  while (b.dead > 0) {
    stepButt(b, dt);
    frames++;
    assert.equal(
      !!b.face.userData.arrowTarget,
      isTargetable(b),
      `frame ${frames} of the fall: the flag (${b.face.userData.arrowTarget}) and isTargetable (${isTargetable(b)}) disagree`,
    );
    assert.equal(isTargetable(b), false, `frame ${frames} of the fall: a struck butt is not a target`);
  }
  assert.ok(frames > 1, "the fall should take more than a single frame, or this checked nothing");
  assert.equal(!!b.face.userData.arrowTarget, false, "and it is not a target once the fall has run out either");
});

test("bestSymbolAfter tracks the cumulative total per ticker, not the single biggest hit", () => {
  const points = new Map<string, number>();
  let best = bestSymbolAfter(points, { bestSymbol: "", bestSymbolPoints: 0 }, "AAA", 50);
  assert.equal(best.bestSymbol, "AAA");
  assert.equal(best.bestSymbolPoints, 50);

  best = bestSymbolAfter(points, best, "BBB", 80);
  assert.equal(best.bestSymbol, "BBB", "a single bigger hit takes the lead");
  assert.equal(best.bestSymbolPoints, 80);

  // AAA's second hit is smaller than BBB's one big hit, but it pushes AAA's
  // running total past BBB's — the cumulative total is what should decide
  // the leader, not whichever ticker handed back the single biggest hit.
  best = bestSymbolAfter(points, best, "AAA", 40);
  assert.equal(points.get("AAA"), 90);
  assert.equal(best.bestSymbol, "AAA", "the cumulative total, not the single biggest hit, decides the leader");
  assert.equal(best.bestSymbolPoints, 90);
});

/*
 * Task 2 gave every arrow gravity in `stepArrows`; `looseEnemyArrow`'s flat,
 * straight-at-the-camera aim was never revisited, so a hostile arrow now
 * drops out from under its own aim line. The whole-branch review simulated
 * this exact function 1,800 times and scored zero hits. This drives the
 * real `looseEnemyArrow` and `stepArrows` — no reimplementation of either —
 * at each lane and a spread of x positions, and fails outright if a single
 * shot does not connect.
 */
test("a hostile arrow loosed at the player from every lane comes within HIT_RADIUS", () => {
  const originalRandom = Math.random;
  const player = new T.Object3D();
  const at = new T.Vector3(0, 3.6, 20);
  player.position.copy(at);
  player.userData.isPlayer = true;

  try {
    for (const laneZ of LANES) {
      for (const x of [-25, 0, 25]) {
        for (const speedFrac of [0, 1]) {
          // Pin every rand() call (speed, spin, ...) to one end of its range,
          // so this is deterministic rather than a flaky draw.
          Math.random = () => speedFrac;

          const scene = new T.Scene();
          scene.add(player);
          const group = new T.Group();
          group.position.set(x, 0, laneZ);
          const fakeButt = { group } as unknown as import("../src/app/(site)/range/butts").Butt;

          const arrow = looseEnemyArrow(scene, fakeButt, at);
          const arrows: Arrow[] = [arrow];

          let hitPlayer = false;
          const dt = 1 / 60;
          for (let i = 0; i < 300 && arrows.length && !hitPlayer; i++) {
            stepArrows(arrows, dt, scene, (_a, hit) => {
              if (hit === player) hitPlayer = true;
            });
          }
          assert.ok(hitPlayer, `lane ${laneZ}, x ${x}, speedFrac ${speedFrac} should have hit the player`);
        }
      }
    }
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * Found while verifying the fix above against a real `Butt` in the browser
 * (`window.__arcade`), not by inspection: `from` in `looseEnemyArrow` sits
 * exactly on the face's own plane (the face is a zero-thickness disc
 * centred at that same point), and `stepArrows` raycasts every arrow —
 * including one still on frame zero — against every live face, this one's
 * own included. A ray whose origin lies on that plane self-intersects at
 * distance zero before the arrow has gone anywhere, `stuck` on the very
 * frame it spawns. This was invisible both to the test above (whose fake
 * butt has a bare `T.Group` for a face, i.e. no geometry to self-intersect)
 * and to the reviewer's own 1,800-trial simulation for the same reason —
 * so a full natural round in the live game still did zero damage even
 * after the ballistics fix, until this was found and fixed too.
 */
test("a hostile arrow does not self-intersect its own launching butt's face on the frame it spawns", () => {
  const scene = new T.Scene();
  const player = new T.Object3D();
  const at = new T.Vector3(0, 3.6, 20);
  player.position.copy(at);
  player.userData.isPlayer = true;
  scene.add(player);

  const group = new T.Group();
  group.position.set(0, 0, LANES[0]);
  // A real face mesh — no texture map, so no `document`/DOM dependency —
  // standing in for the one `makeButt` actually builds.
  const face = new T.Mesh(new T.CircleGeometry(FACE_RADIUS, 22), new T.MeshBasicMaterial({ side: T.DoubleSide }));
  face.position.y = 5.2;
  face.userData.arrowTarget = true;
  group.add(face);
  scene.add(group);

  const fakeButt = { group } as unknown as import("../src/app/(site)/range/butts").Butt;
  const arrow = looseEnemyArrow(scene, fakeButt, at);
  const arrows: Arrow[] = [arrow];

  stepArrows(arrows, 1 / 60, scene, () => {});

  assert.equal(
    arrow.stuck,
    0,
    "the arrow must not stick to the face it was just fired from on the very frame it spawns",
  );
});

test("looseEnemyArrow's elevation is clamped rather than NaN when the range is beyond what the speed can reach", () => {
  const scene = new T.Scene();
  const group = new T.Group();
  group.position.set(0, 0, 0);
  const fakeButt = { group } as unknown as import("../src/app/(site)/range/butts").Butt;
  // Absurdly far, so GRAVITY * range / speed^2 is guaranteed to exceed 1.
  const farAway = new T.Vector3(0, 3.6, -100000);

  const arrow = looseEnemyArrow(scene, fakeButt, farAway);

  assert.ok(Number.isFinite(arrow.vel.x), "vel.x must not be NaN");
  assert.ok(Number.isFinite(arrow.vel.y), "vel.y must not be NaN");
  assert.ok(Number.isFinite(arrow.vel.z), "vel.z must not be NaN");
  assert.ok(arrow.vel.y > 0, "the best available shot at an out-of-range target is still the steepest one, not level");
});

/*
 * The other half of the same arithmetic: the player's own shot.
 *
 * `looseEnemyArrow` was launching flat down its aim line and scoring zero
 * hits, because gravity drops an arrow out from under a straight line to the
 * target; the test above is what pinned its fix. `World.fire` had exactly the
 * same defect and never got the fix — it built a ray down the centre of the
 * view, threw the ray away, and sent the arrow off along the direction alone.
 * A shot the reticle said was dead centre landed metres low at the near rank
 * and further still at the far one, which is the whole of "hits aren't
 * registering": the arrows were real, the reticle was lying about where they
 * went.
 *
 * Stated as a relationship and never as a transcribed hit rate: a shot aimed
 * dead centre at a face connects with *that* face. Both ranks, and a spread
 * of spawn positions rather than one lucky butt — `x` is `rand(-30, 30)`, so
 * the horizontal range to a near-rank butt runs from 42 to over 51 units and
 * a far-rank one from 60 to 67, and the elevation each of those needs is a
 * different number.
 *
 * Why it waits for a butt with flight time to spare on its dwell: the filter
 * has to leave a standing target that is still standing when the arrow
 * lands, or a duck mid-flight gets blamed on the ballistics. That used to
 * mean aiming only at hostile butts, because a green one dwelled `rand(0.5,
 * 1.2)`s once fully up against the ~1.3s an arrow needs to cross the far
 * rank and would start sinking under a perfectly aimed shot — which was a
 * second, separate defect this test was quietly steering around, and is now
 * fixed (`dwellFor` in butts.ts, and the live test below). The stock list
 * here is still every ticker down, so every butt is red and the volleys are
 * paced the same way they were when this test was written; the filter is now
 * `flightTimeTo(b.rank)` rather than a transcribed 1.6, which is the real
 * condition and is satisfied by every butt of either colour today. Nothing
 * else about the butt being hostile touches this: it shoots back, and being
 * shot at moves health, not where our own arrow goes.
 *
 * Why it waits for a butt standing alone: a second butt up at the same time
 * can be the one the arrow legitimately meets — a near-rank face between the
 * eye and a far-rank one, or a same-rank neighbour whose face overlaps this
 * one's — and a shot stopped by something genuinely in the way is not a
 * ballistics failure. One target on the range removes the question entirely.
 * Wave 0 spawns every 1.2-2.0s against the 0.42s a butt takes to rise, so
 * the first one up is alone for long enough to shoot; a trial where a second
 * arrives first is abandoned rather than scored.
 *
 * The assertion is on the target butt's own `dead`, not on the round's hit
 * count: `dead > 0` is the struck butt falling away, so this pins the arrow
 * to the face it was aimed at rather than to any face, and it is the same
 * state the player sees as a target dropping when hit.
 */
test("a dead-centre shot connects: aimed at a standing butt's face, the arrow lands in that face — both ranks, right across the spread of spawn positions", () => {
  const dt = 1 / 60;
  // Every stock down, so every butt that rises is hostile — the same range
  // this test has always been driven against; see above.
  const stocks = [{ symbol: "DN", changePct: -1 }];
  // `look`'s own unscoped sensitivity, which is the only way in to yaw and
  // pitch from outside the class. Deltas are measured off `facing`, so this
  // lands on exactly the angle wanted rather than accumulating.
  const LOOK_K = 0.0022;

  const shoot = (rank: "near" | "far") => {
    const w = new World(makeNullSurface(), stocks, () => {});
    w.start();
    let target: Butt | undefined;
    for (let f = 0; f < 600; f++) {
      w.step(dt);
      if (w.butts.length > 1) return null;
      const b = w.butts[0];
      if (b && b.rank === rank && b.behaviour === "stand" && b.out >= 1 && b.dead === 0 && b.dwell > flightTimeTo(rank)) {
        target = b;
        break;
      }
    }
    if (!target) return null;

    // Aim the way the camera does: straight at the face's world position,
    // reticle dead centre (`look` re-centres `aim` itself).
    const face = target.face.getWorldPosition(new T.Vector3());
    const d = face.clone().sub(w.eye);
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.asin(d.y / d.length());
    w.look(-(yaw - w.facing.yaw) / LOOK_K, -(pitch - w.facing.pitch) / LOOK_K);
    // A clamped view is not a dead-centre shot, and would make a miss below
    // mean something other than what this test is about.
    assert.ok(
      Math.abs(w.facing.yaw - yaw) < 1e-6 && Math.abs(w.facing.pitch - pitch) < 1e-6,
      "the view has to actually reach the face, or the shot below was never aimed at it",
    );

    assert.ok(w.fire(), "the nock is full at the start of a round, so the shot has to loose");
    const arrow = w.arrows[w.arrows.length - 1];
    for (let g = 0; g < 600 && arrow.stuck === 0 && w.arrows.includes(arrow); g++) w.step(dt);
    const struck = target.dead > 0;

    // The other half of what the player reported — "targets need to drop when
    // hit" — measured on the same shot rather than argued about. `stepButt`'s
    // death branch has always done this; there was simply never a hit to set
    // it off, which is why it was invisible. A third of a second of the fall
    // is enough to see it without running into `world.ts`'s own filter
    // retiring the butt at `DEATH_FALL_TIME`.
    const heldAt = target.group.position.y;
    const facedAt = target.group.rotation.z;
    for (let g = 0; g < 20; g++) w.step(dt);
    const fell = heldAt - target.group.position.y;
    const turned = Math.abs(target.group.rotation.z - facedAt);

    w.stop();
    return { x: +target.x.toFixed(1), range: +Math.hypot(d.x, d.z).toFixed(1), struck, fell, turned };
  };

  for (const rank of ["near", "far"] as const) {
    const shots = [];
    for (let i = 0; i < 300 && shots.length < 20; i++) {
      const r = shoot(rank);
      if (r) shots.push(r);
    }
    assert.ok(shots.length >= 20, `${rank} rank: not enough standing butts came up alone to say anything about the ballistics`);
    const xs = shots.map((s) => s.x);
    assert.ok(
      Math.min(...xs) < -8 && Math.max(...xs) > 8,
      `${rank} rank: the butts shot at have to be spread across the range, not clustered where one elevation happens to work (saw x from ${Math.min(...xs)} to ${Math.max(...xs)})`,
    );
    const missed = shots.filter((s) => !s.struck).map((s) => ({ x: s.x, range: s.range }));
    assert.deepEqual(
      missed,
      [],
      `${rank} rank: a shot aimed dead centre at a standing face must land in it, at every range that face can stand at`,
    );
    const stoodThere = shots.filter((s) => s.fell < 2 || s.turned < 1);
    assert.equal(
      stoodThere.length,
      0,
      `${rank} rank: a struck butt has to visibly fall away and turn as it goes; the drop was always there, and a hit landing is what finally makes it something anyone sees`,
    );
  }
});

/*
 * The half of "hits aren't registering" that a correct arrow cannot fix.
 *
 * The test above proves the arrow arrives where it was aimed. It can only
 * prove that because it waits for a butt whose `dwell` is long enough to
 * still be there when the arrow lands — which, before the dwells were
 * derived from the flight times, meant a hostile one. That filter is what
 * kept this defect out of sight: a green butt was given 0.5-1.2s fully up
 * against a flight of 1.05s to the near rank and 1.37s to the far one, so
 * the far rank's target was always back in cover before the arrow could
 * arrive and the near rank's was a coin toss. The arrow was right and the
 * target was gone.
 *
 * So this one filters on nothing. It takes whatever comes up, of either
 * colour, fires dead centre the first frame it is *fully* up — the earliest
 * moment a player could be sure of what they were aiming at — and follows
 * the shot to wherever it resolves. What it asserts is the relationship the
 * game needs and not a percentage: a target you can see and aim at is a
 * target you can hit. A transcribed hit rate would pass just as happily at
 * 50% as at 100%, and 50% is what the near rank was.
 *
 * Both colours, because a green butt is the one the player is scored on and
 * a red one is how the player stops being shot at, and they are given their
 * dwell by two different expressions. Both ranks separately, because the
 * far rank is 16 units further out and the whole point of deriving the
 * dwell is that one number cannot serve both.
 *
 * `w.butts.length > 1` abandons a trial rather than failing it, for the
 * reason the test above gives: a second butt up can legitimately be the one
 * the arrow meets, and a shot stopped by something genuinely in the way is
 * not what this is asking about.
 */
test("a target you can see and aim at is a target you can hit: fired dead centre the frame it stands fully up, at both ranks, green and red", () => {
  const dt = 1 / 60;
  // `look`'s own unscoped sensitivity — see the test above, which aims the
  // same way for the same reason.
  const LOOK_K = 0.0022;

  const shoot = (rank: Rank, hostile: boolean) => {
    const stock = [{ symbol: hostile ? "DN" : "UP", changePct: hostile ? -1 : 1 }];
    const w = new World(makeNullSurface(), stock, () => {});
    w.start();
    let target: Butt | undefined;
    for (let f = 0; f < 600; f++) {
      w.step(dt);
      if (w.butts.length > 1) break;
      const b = w.butts[0];
      if (b && b.rank === rank && b.behaviour === "stand" && b.out >= 1 && b.dead === 0) {
        target = b;
        break;
      }
    }
    if (!target) {
      w.stop();
      return null;
    }
    const face = target.face.getWorldPosition(new T.Vector3());
    const d = face.clone().sub(w.eye);
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.asin(d.y / d.length());
    w.look(-(yaw - w.facing.yaw) / LOOK_K, -(pitch - w.facing.pitch) / LOOK_K);
    assert.ok(
      Math.abs(w.facing.yaw - yaw) < 1e-6 && Math.abs(w.facing.pitch - pitch) < 1e-6,
      "the view has to actually reach the face, or the shot below was never aimed at it",
    );
    assert.ok(w.fire(), "the nock is full at the start of a round, so the one shot has to loose");
    const arrow = w.arrows[w.arrows.length - 1];
    for (let g = 0; g < 600 && arrow.stuck === 0 && w.arrows.includes(arrow); g++) w.step(dt);
    const shot = {
      x: +target.x.toFixed(1),
      range: +Math.hypot(d.x, d.z).toFixed(1),
      dwell: +target.dwell.toFixed(2),
      struck: target.dead > 0,
      // A butt that is neither struck nor still fully up ducked back into
      // cover while the arrow was in the air — the failure this test exists
      // for, named so a regression says which of the two it is.
      ducked: target.dead === 0 && target.out < 1,
    };
    w.stop();
    return shot;
  };

  // Every group is run before anything is asserted about the misses, so a
  // failure names all four rather than stopping at whichever one happens to
  // break first — the near rank and the far rank fail for the same reason
  // and by different amounts, and seeing only one of them is how the far
  // rank's flight time gets mistaken for the near rank's.
  const misses: Record<string, { x: number; range: number; dwell: number; ducked: boolean }[]> = {};
  for (const hostile of [false, true]) {
    for (const rank of ["near", "far"] as const) {
      const label = `${hostile ? "red" : "green"} ${rank}`;
      const shots = [];
      for (let i = 0; i < 260 && shots.length < 15; i++) {
        const r = shoot(rank, hostile);
        if (r) shots.push(r);
      }
      assert.ok(shots.length >= 15, `${label}: not enough butts came up alone to say anything about the population`);
      const xs = shots.map((s) => s.x);
      assert.ok(
        Math.min(...xs) < -8 && Math.max(...xs) > 8,
        `${label}: the butts shot at have to be spread across the rank, not clustered where one dwell happens to be long enough (saw x from ${Math.min(...xs)} to ${Math.max(...xs)})`,
      );
      const missed = shots.filter((s) => !s.struck).map((s) => ({ x: s.x, range: s.range, dwell: s.dwell, ducked: s.ducked }));
      if (missed.length) misses[label] = missed;
    }
  }
  assert.deepEqual(
    misses,
    {},
    "a butt standing fully up, aimed at dead centre and shot at once, must be hit: a target that ducks back into cover while the arrow aimed at it is still in the air is not a target the player can play against, at either rank or either colour",
  );
});

/*
 * Bug A ("bow is inaccurate" / "bow doesn't shoot when scoped in"):
 * `page.tsx`'s `onPointerDown` used to call the same `aimAt` a real
 * `pointermove` calls, immediately before firing. Scoped, `aimAt` reads
 * whatever gap sits between the cursor's last recorded position and the
 * event's own coordinates and turns the view by it — right for a genuine
 * move, wrong for a press, whose coordinates need never match wherever the
 * last real move left the cursor (a coalesced `pointerdown`, or a tap with
 * no preceding move over that pixel at all). That swung the view in the
 * same event that loosed the arrow, largest exactly when a target was being
 * tracked and clicked in one motion — measured live at 2.6° to 20.6° of
 * swing across 5% to 40% of the canvas width.
 *
 * `World.syncCursor` is the fix: it records the press's own position
 * without turning anything. Both halves are asserted, per the task's own
 * warning that recording nothing at all on the press just moves the bug
 * onto the next move instead of removing it: the press itself must not
 * turn the view, and a subsequent genuine move must pan by its own delta
 * from where the press left the cursor, not by the gap the press covered.
 */
test("a scoped press does not turn the view, and the next genuine move still pans by its own delta", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  // A baseline unscoped move records the cursor centred without turning
  // anything (`aimAt`'s unscoped branch never pans) — standing in for the
  // player's last real pointermove before the scope went up.
  w.aimAt(0.5, 0.5);
  w.setScoped(true);
  const beforePress = w.facing;
  // Not `assert.deepEqual` against a literal `{yaw:0,pitch:0}`: a ray traced
  // dead centre can legitimately come back `-0` rather than `0` (`Math.atan2`
  // does that for a direction with an exactly-zero x component), which is
  // the same angle in every sense that matters here but fails a strict
  // object comparison against a hand-written positive zero. What actually
  // matters — that raising the scope over a centred cursor did not turn
  // anything — is a magnitude check, not a sign check.
  assert.ok(
    Math.abs(beforePress.yaw) < 1e-9 && Math.abs(beforePress.pitch) < 1e-9,
    `raising the scope over an already-centred cursor must not itself turn the view (got ${JSON.stringify(beforePress)})`,
  );

  // The press lands 20% of the canvas away from the last recorded cursor —
  // squarely inside the task's own measured table (10.3° of swing at this
  // offset under the old code).
  w.syncCursor(0.7, 0.5);
  assert.deepEqual(
    w.facing,
    beforePress,
    "a press that lands away from the last cursor position must not turn the scoped view",
  );

  // The next genuine move — a real pointermove after the press — must pan
  // by its own small delta from where the press left the cursor (0.7 to
  // 0.75), not by the gap the press itself covered (0.5 to 0.75, which the
  // old code would have left for this move to inherit).
  w.aimAt(0.75, 0.5);
  const ownDelta = -(0.75 - 0.7) * 0.9;
  const staleDelta = -(0.75 - 0.5) * 0.9;
  assert.ok(
    Math.abs(w.facing.yaw - ownDelta) < 1e-9,
    `the move should pan by its own 0.05 delta (expected yaw ${ownDelta}), not something else (got ${w.facing.yaw})`,
  );
  assert.ok(
    Math.abs(w.facing.yaw - staleDelta) > 0.1,
    "the move must not carry the press's own distance forward as if the press had never updated the cursor",
  );
});

/*
 * The gate itself, in isolation — the arithmetic that the two-path parity
 * test below rests on.
 *
 * There were once two thresholds: `fire` asked for half a nock while the
 * desktop hold asked for a full one, and touch reached `fire` directly, so a
 * tapping phone could loose every ~210ms against a mouse's ~525ms. The hold
 * is gone and both inputs now enter through `fire`, which makes this the
 * single question either of them asks. That is what earns it its own test
 * and not fewer: a half-nock door reopening here would be the whole of the
 * old platform imbalance coming back, and it would come back for *both*
 * inputs at once, which is exactly the shape of defect an end-to-end parity
 * test cannot see.
 */
test("the nock gate is one full refill, and the old half-nock door stays shut", () => {
  assert.equal(nockReady(0), false);
  assert.equal(nockReady(0.5), false, "0.5 was fire()'s own old threshold — exactly what let touch fire 2.5x as fast");
  assert.equal(nockReady(0.99), false);
  assert.equal(nockReady(1), true);
});

/*
 * Desktop and phone are one board, so they have to be one game.
 *
 * Scores from both post to the same weekly leaderboard, and that board pays
 * a prize — so a platform that can put more arrows in the air than the other
 * over the same seconds of clock, or send them out faster when it does, is a
 * defect in the board and not a balance question to argue about. Desktop
 * used to hold to draw, which made that comparison a genuinely open one: a
 * held pull bought a faster arrow than a tap's fixed draw could. One click,
 * one arrow closed it, and this is what holds it closed.
 *
 * Asserted as a relationship between the two paths and never as a
 * transcribed number: the rate of fire and the arrow speed are both free to
 * be retuned, and neither is what this test is about. What it refuses is the
 * two of them ever disagreeing.
 *
 * Both drivers press as fast as the input allows — `fire` returns false for
 * free while the nock is refilling, so calling it every frame is the most
 * either platform could possibly get out of the window. The window is the
 * round's first five seconds, which is what `msLeft > ROUND_MS - windowMs`
 * says — well clear of the last two seconds' slow motion, which is the only
 * part of the clock that could move the rate of fire. A single up stock keeps
 * the range hostile-free so nothing but the clock can end it.
 */
test("a click and a tap loose the same arrows, as many and as fast, over the same window", () => {
  const dt = 1 / 60;
  const windowMs = 5_000;
  const stock = [{ symbol: "UP", changePct: 1 }];

  const press = (touch: boolean) => {
    const w = new World(makeNullSurface(), stock, () => {});
    w.start();
    const speeds: number[] = [];
    while (w.msLeft > ROUND_MS - windowMs && !w.over) {
      // `touch` is the one thing that differs between the two runs: which
      // input this shot came from. It must not reach the rate of fire or the
      // arrow's speed at all — only the aim assist, which is measured by its
      // own test elsewhere.
      if (w.fire(touch)) speeds.push(w.arrows[w.arrows.length - 1].vel.length());
      w.step(dt);
    }
    return speeds;
  };

  const click = press(false);
  const tap = press(true);

  assert.ok(
    click.length > 1,
    "the window has to be long enough for the rate of fire to actually bind, or the equalities below compare nothing",
  );
  assert.equal(
    tap.length,
    click.length,
    "a tap and a click must get the same number of arrows out of the same span of clock",
  );
  /*
   * The same speed, not the same bits.
   *
   * This was `deepEqual` on the two arrays, which held while the shot speed
   * happened to be a float both paths reproduced exactly, and started
   * failing on 79.99999999999999 against 80 when it changed — one unit in
   * the last place, out of an elevation solved through `atan2`, `sqrt`,
   * `cos` and `sin` before the velocity is scaled. Bitwise equality was
   * never the property; "a thumb and a mouse loose the same arrow" is, and
   * a tolerance this tight still catches any real divergence while
   * surviving arithmetic that is allowed to round differently.
   */
  for (let i = 0; i < click.length; i++) {
    assert.ok(
      Math.abs(tap[i] - click[i]) < 1e-9,
      `arrow ${i + 1} must leave at the same speed on both platforms — tap ${tap[i]}, click ${click[i]}`,
    );
  }
  // Same tolerance, same reason as the comparison just above: the elevation
  // is solved through atan2/sqrt/cos/sin before the velocity is scaled, so
  // two shots at different ranges can land a unit in the last place apart
  // while being the same speed in every sense the game has.
  assert.ok(
    click.every((v) => Math.abs(v - click[0]) < 1e-9),
    `no shot may leave faster or slower than another: there is one draw now, and the player does not set it — saw ${[...new Set(click)].join(", ")}`,
  );
});

/*
 * Bug B (the rest of report 1: "bow is inaccurate"): `fire()` solves the
 * elevation exactly, to wherever the aim ray lands — verified in the tests
 * above — but it aims at where a moving target's face stood the instant the
 * reticle found it, not where that face will be once the arrow, loosed now,
 * actually gets there 0.86-1.37s later. A `drift` target moves about 2.5
 * units in that time against a hit radius of 2.6, so a shot the reticle
 * said was dead centre the moment it was aimed lands where the target used
 * to be.
 *
 * Written the way the bug was found: a live `World`, aim dead centre at the
 * drifting face as it stands right now, fire once, step until the arrow
 * resolves. The target itself is built with `makeButt` and put directly into
 * the world's own scene and butt list — the same two things `World.spawn`
 * does, minus the coin-flips (which stock, which rank, which x, which
 * direction and speed) — rather than waited for out of the real spawner.
 * Wave 0 only ever spawns `stand` (`BEHAVIOURS_BY_WAVE` in butts.ts), so
 * waiting on the spawner for a `drift` butt of a *specific* rank, at a
 * *specific* x, alone, and staying alone for the whole of a flight, needs
 * wave 1 or later and would still be rare and slow to gather in volume; a
 * built butt gets every one of those for free and lets this sweep x and
 * drift direction/speed deliberately, the way the earlier dead-centre tests
 * sweep spawn position by waiting for it. `dwell` is set high enough that a
 * duck mid-flight cannot be blamed on the lead, and each trial aims and
 * fires exactly once — a throwaway probe shot is not an option, since
 * `fire()` zeroes `drawn` and a second shot would not be the first one
 * aimed.
 *
 * The assertion is the relationship, not a percentage, exactly as the two
 * tests above it already do it: a shot aimed dead centre at a target the
 * player can see and track must connect, moving or not. Run with the lead
 * itself disabled — the `if (targetButt)` block below deleted, `point` left
 * exactly as the ray struck it — over the same 36 shots a side, the near
 * rank came back clean (36/36: this sweep's own `vx`/`x` combinations happen
 * to keep the near rank's larger face and shorter flight inside the old
 * code's tolerance) and the far rank missed 18 of 36 — 50%, in the same
 * range the task's own live measurement of drift/far reports (30% hit, 70%
 * miss). A live round's actual spread of drift speeds is not this test's
 * fixed sweep, and near/far diverging here rather than matching the task's
 * table on both is that difference, not a sign the bug was only ever half
 * real: the far rank's smaller face (half the near rank's radius) and
 * longer flight (up to 1.37s against 1.05s) make it the one this sweep was
 * always going to catch. After leading the shot, both ranks come back clean.
 */
test("a dead-centre shot leads a drifting target: aimed at where it stands, it still connects once the arrow arrives", () => {
  const dt = 1 / 60;
  // `look`'s own unscoped sensitivity — see the earlier dead-centre tests,
  // which aim the same way for the same reason.
  const LOOK_K = 0.0022;
  const stock = { symbol: "UP", changePct: 1 };
  // No stocks handed to `World` itself: `spawn` (which draws from
  // `this.stocks`) no-ops on an empty list, so nothing but the one butt
  // this test raises by hand is ever on the range — the same "one target on
  // the range removes the question entirely" reasoning the earlier
  // dead-centre tests rely on, made true by construction instead of by
  // waiting for it and hoping.
  const w = new World(makeNullSurface(), [], () => {});

  /*
   * Raise one `drift` butt directly, fully up and already moving, bypassing
   * `World.spawn`'s own random draw of rank/x/direction/speed entirely — the
   * scene and butt list are private, but `w.butts` already hands back the
   * live array `world.ts` itself mutates (see its own doc comment: "the
   * test... needs to see what it actually did... without a second copy of
   * `World`'s own spawn/retire logic living in the test file"), so pushing
   * onto it is using that same seam rather than a new one. The scene has no
   * such getter, so this is the one place this file reaches past a private
   * field, and only to put the mesh where `collectTargets` (arrows.ts) —
   * which walks the real scene graph — can find it, exactly as `spawn` does.
   *
   * `rising: true` here is not "still climbing out of cover" — `stepButt`
   * only advances `out` past 1 while `rising` is true and drops it back
   * toward 0 the instant it is false, so a fully-up butt meant to *stay* up
   * is `rising: true` with `out` already at 1 and `dwell` left high, not
   * `rising: false`. Getting this backwards was this test's own first bug,
   * not the fix's: it ducked the injected butt back into cover about a
   * third of a second in (`out` decays at `2.4`/s from 1, and `isTargetable`
   * needs it above 0.15), well inside the flight, and then removed it from
   * the scene entirely — so every shot flew on into open air and the arrow
   * was blamed on the lead for a target that was never there to hit.
   */
  const raise = (rank: Rank, x: number, vx: number): Butt => {
    const butt = makeButt(stock, rank, x, "drift");
    butt.vx = vx;
    butt.out = 1;
    butt.rising = true;
    butt.dwell = 999; // long past any flight time; nothing here should duck
    butt.group.position.set(x, 0, RANKS[rank].z); // stepButt's own fully-up position
    butt.face.userData.arrowTarget = true;
    (w as unknown as { scene: T.Scene }).scene.add(butt.group);
    (w.butts as Butt[]).push(butt);
    return butt;
  };

  const shoot = (rank: Rank, x: number, vx: number) => {
    w.start();
    const target = raise(rank, x, vx);

    // Aim dead centre at the face's position right now — where the target
    // is, not where it is going, exactly what the player's own click does
    // and exactly what the bug report measured against.
    const face = target.face.getWorldPosition(new T.Vector3());
    const d = face.clone().sub(w.eye);
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.asin(d.y / d.length());
    w.look(-(yaw - w.facing.yaw) / LOOK_K, -(pitch - w.facing.pitch) / LOOK_K);
    assert.ok(
      Math.abs(w.facing.yaw - yaw) < 1e-6 && Math.abs(w.facing.pitch - pitch) < 1e-6,
      "the view has to actually reach the face, or the shot below was never aimed at it",
    );

    assert.ok(w.fire(), "the nock is full at the start of a round, so the one shot has to loose");
    const arrow = w.arrows[w.arrows.length - 1];
    for (let g = 0; g < 600 && arrow.stuck === 0 && w.arrows.includes(arrow); g++) w.step(dt);
    return { x, struck: target.dead > 0 };
  };

  for (const rank of ["near", "far"] as const) {
    const shots: { x: number; struck: boolean }[] = [];
    // A deliberate sweep across the rank's own spread (`SPAWN_X_LIMIT` is
    // 30) and both drift directions at two speeds, rather than a spawn
    // position taken on faith from the RNG — every combination the task's
    // own measurement table would call a `drift` shot.
    for (const x of [-28, -21, -14, -7, 0, 7, 14, 21, 28]) {
      for (const vx of [-3.5, -2, 2, 3.5]) {
        shots.push(shoot(rank, x, vx));
      }
    }
    assert.equal(shots.length, 36, `${rank} rank: the sweep itself should never lose a trial`);
    const missed = shots.filter((s) => !s.struck);
    assert.deepEqual(
      missed,
      [],
      `${rank} rank: a shot aimed dead centre at a drifting face, the moment it was aimed, must still connect once the arrow arrives — the shot has to be led to where the target the reticle found will actually be`,
    );
  }
  w.stop();
});

/*
 * `steerToward`'s old `* 10` rate let it out-correct gravity every frame, so
 * any shot inside the assist cone converged onto the exact same point
 * regardless of how far off it had been aimed — the reviewer measured
 * identical impact radii for a perfectly aimed shot and one 2.5 degrees off.
 * This fires two shots at the same target, one with a small aim error and
 * one with a larger one (both still inside the mouse assist cone), and
 * requires the larger error to land further off-centre — "forgiven", not
 * "decided for you."
 */
/*
 * Attract mode's own rules — the wood runs from the moment the page loads,
 * but the clock, hostiles and their consequences must all stay off until a
 * real round begins. This used to be provable only against `attractStep`
 * itself, or against a hand-written stand-in that folded the gate into its
 * own tiny copy of `step`'s bookkeeping — neither of which could ever
 * notice `attractStep` being wired up wrong, or forgotten at a call site,
 * inside the real `world.ts`. `World` no longer needs a real WebGL canvas
 * to build (see `render.ts`), so this drives the real `World`, the real
 * `attract()` and the real `step()` (via 600 real frames) end to end, and
 * checks the real `points`/`health`/`msLeft`/`butts` it produced — the
 * property the earlier attempts lacked is that deleting this test is the
 * only way to stop it guarding the bug, not editing it.
 *
 * One assertion here HAS since been edited, which is worth saying plainly.
 * It read `butts.filter(b => b.hostile).length === 0` — no red butt may be
 * raised at all. That was a proxy for "hostiles are off", and the proxy was
 * what left attract mode with an empty wood on a market-wide selloff, when
 * every ticker is red and the filter had nothing to draw from. Attract mode
 * now draws from the whole day. So the assertion is replaced by the two
 * things it was standing in for, both of which are stronger than it was and
 * neither of which the old test checked at all: nothing may enter the
 * wind-up, and no hostile arrow may ever exist. What is no longer asserted
 * — that `spawn` itself was handed the gate — is no longer a defect either:
 * the colour of a butt on the menu has no effect on the clock, the score,
 * the health or the danger, and those are all still checked here.
 *
 * What that swap did cost, and what the last assertion below puts back, is
 * the only line that required anything to be raised at all. Counting red
 * butts implied a wood with butts in it; counting wind-ups and hostile
 * arrows and finding none does not. Every assertion here would have been
 * satisfied by an attract mode that raised nothing — which is the exact
 * bug the change was fixing — and this test is built to stand on its own
 * rather than lean on the all-red one that also covers it.
 */
test("attract mode cannot advance the clock, score, or let anything shoot", () => {
  const w = new World(makeNullSurface(), [
    { symbol: "UP", changePct: +1 },
    { symbol: "DOWN", changePct: -1 },
  ], () => {});
  w.attract();
  const before = { points: w.points, health: w.health, msLeft: w.msLeft };
  const raised = new Set<unknown>();
  let windingUp = 0;
  let hostileArrows = 0;
  for (let i = 0; i < 600; i++) {
    w.step(1 / 60);
    for (const b of w.butts) raised.add(b);
    windingUp += w.butts.filter((b) => b.winding).length;
    hostileArrows += w.arrows.filter((a) => !a.mine).length;
  }
  assert.equal(w.points, before.points);
  assert.equal(w.health, before.health);
  assert.equal(w.msLeft, before.msLeft);
  assert.equal(windingUp, 0, "no butt may so much as begin a wind-up while the menu is up");
  assert.equal(hostileArrows, 0, "and none may ever loose an arrow");
  assert.ok(
    raised.size > 0,
    "the menu's wood has to fill — an attract mode that raised nothing would pass every assertion above it",
  );
});

/*
 * The far rank is worth double the near one — Phase 1's ring multiplier
 * (gold 3x, red 2x, ...) still decides the base, `resolveButtHit`'s
 * `rankBonus` only multiplies on top of it. Same ring, same everything else,
 * only the rank differs, so the ratio between the two totals has to be
 * exactly the ratio between `RANKS.far.bonus` and `RANKS.near.bonus` — not a
 * number read off one run of the game.
 */
test("a far-rank hit scores double a near-rank hit of the same ring", () => {
  const near = resolveButtHit({
    hostile: false,
    ring: 1,
    basePoints: 100,
    comboBefore: 0,
    streakBefore: 0,
    bestRingBefore: 0,
    rankBonus: RANKS.near.bonus,
  });
  const far = resolveButtHit({
    hostile: false,
    ring: 1,
    basePoints: 100,
    comboBefore: 0,
    streakBefore: 0,
    bestRingBefore: 0,
    rankBonus: RANKS.far.bonus,
  });
  assert.equal(
    far.gained,
    near.gained * (RANKS.far.bonus / RANKS.near.bonus),
    "the far rank's own bonus should scale an otherwise identical hit by exactly its own ratio",
  );
});

/*
 * Wave itself is not a system yet (that is Task 4) — `pickBehaviour` only
 * has to be conservative given whatever plain number it is handed: `stand`
 * alone at wave 0, so the first stretch of a round teaches the game before
 * anything moves or shoots back; every behaviour reachable by wave 2, so the
 * late-round storm actually has all four in it. The rng is injected and
 * swept across its whole range so this is a property of the selection logic,
 * not a single lucky (or unlucky) draw.
 */
test("pickBehaviour returns only stand at wave 0, and all four by wave 2", () => {
  const seenAtWave0 = new Set<Behaviour>();
  for (let i = 0; i < 50; i++) seenAtWave0.add(pickBehaviour(0, () => i / 50));
  assert.deepEqual([...seenAtWave0], ["stand"], "wave 0 must offer stand and nothing else, however the rng lands");

  const seenAtWave2 = new Set<Behaviour>();
  for (let i = 0; i < 50; i++) seenAtWave2.add(pickBehaviour(2, () => i / 50));
  assert.deepEqual(
    [...seenAtWave2].sort(),
    ["drift", "peek", "stand", "swing"],
    "by wave 2 every behaviour should be reachable",
  );
});

/*
 * `stepButt` used to drift every butt unconditionally; now lateral motion is
 * gated on `b.behaviour`. This drives the real `stepButt` against a real
 * `makeButt`-built pair, one of each behaviour, and would fail the instant a
 * `stand` target picked up the old unconditional drift again.
 */
test("stepButt moves a drift sideways and not a stand", () => {
  const drift = makeButt({ symbol: "AAA", changePct: 1 }, "near", 0, "drift");
  const stand = makeButt({ symbol: "BBB", changePct: 1 }, "near", 0, "stand");
  const dt = 1 / 60;
  for (let i = 0; i < 120; i++) {
    stepButt(drift, dt);
    stepButt(stand, dt);
  }
  assert.notEqual(drift.x, 0, "a drift target should have moved along its rank");
  assert.equal(stand.x, 0, "a stand target should hold its spawn position, not wander");
});

/*
 * "Rises, and drops whether hit or not" — a peek that only ever left the
 * scene when shot would be a drift with extra steps. This drives an unstruck
 * peek past its own window and checks it has started ducking on its own,
 * then drives a struck one through the real `resolveButtHit`/`applyButtHit`
 * hit path and checks the hit takes it out immediately rather than waiting
 * for the window either way.
 *
 * Both ranks, because the window is no longer one number. It was a flat 1.8
 * seconds, set when a click was an instant raycast; it is now `peekWindow`,
 * which is the reaction window plus the flight time to the rank the peek
 * rose in. What this test pins is the behaviour's identity, which is
 * unchanged: whatever the window is, a peek ducks at the end of it.
 */
test("a peek retires within its own rank's window whether or not it is hit", () => {
  const dt = 1 / 60;
  const riseTime = 1 / 2.4; // `out` climbs from 0 to 1 at 2.4/s, same rate `stepButt` uses

  for (const rank of ["near", "far"] as const) {
    const unhit = makeButt({ symbol: "CCC", changePct: 1 }, rank, 0, "peek");
    // Just short of the window, it must still be standing: a peek that ducked
    // early would pass the assertion below for the wrong reason.
    for (let t = 0; t < riseTime + peekWindow(rank) - 0.1; t += dt) stepButt(unhit, dt);
    assert.equal(unhit.rising, true, `${rank} rank: a peek must still be up until its own window is spent`);
    for (let t = 0; t < 0.6; t += dt) stepButt(unhit, dt);
    assert.equal(unhit.rising, false, `${rank} rank: an unstruck peek must have started ducking within its own window`);
    assert.equal(unhit.dead, 0, "it should have left on its own timer, not because anything destroyed it");
  }

  const hit = makeButt({ symbol: "DDD", changePct: 1 }, "near", 0, "peek");
  for (let t = 0; t < riseTime / 2; t += dt) stepButt(hit, dt); // partway up, well inside the window
  const result = resolveButtHit({
    hostile: hit.hostile,
    ring: 1,
    basePoints: 10,
    comboBefore: 0,
    streakBefore: 0,
    bestRingBefore: 0,
  });
  applyButtHit(hit, result);
  stepButt(hit, dt);
  assert.ok(hit.dead > 0, "a peek that is hit should fall away like any other struck target, not linger for its window");
});

/*
 * The same defect the live test above measures, said as arithmetic.
 *
 * The live one is the honest test and it is also a slow, statistical one:
 * it drives real rounds and shoots at whatever comes up. This is the cheap
 * half — it takes the two numbers that have to be compared and compares
 * them, so a failure says *which* number moved rather than only that the
 * hit rate fell.
 *
 * The flight time is worked out here from the game's own constants rather
 * than read back out of `flightTimeTo`: the eye stands at `SHOOTER_Z`, a
 * butt may rise anywhere up to `SPAWN_X_LIMIT` either side of centre, its
 * face is at `FACE_HEIGHT` and the nock at `NOCK_HEIGHT`, and the arrow
 * leaves at `SHOT_SPEED` on the elevation `ballisticElevation` solves for.
 * Range over the flat part of that velocity is the time in the air. It is
 * the same arithmetic `flightTimeTo` does, written out where a reader can
 * check it against the numbers in the doc comments.
 */
test("a butt of each rank stays fully up longer than an arrow takes to reach it, in the worst case of its own spread", () => {
  /*
   * The dwell is only worth anything if the speed it was measured against is
   * the speed a shot really leaves at, so that is asserted against a real
   * arrow out of the real `World` rather than against another constant.
   *
   * It used to read `SHOT_SPEED === drawSpeed(SHOT_DRAW)`, which was a proxy:
   * true only while the speed happened to be a point on the draw curve, and
   * it broke the moment the curve stopped setting it — without anything
   * actually being wrong. The property it was reaching for is this one, and
   * this one cannot drift, because it asks the bow.
   */
  {
    const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
    w.start();
    assert.ok(w.fire(), "the nock is full at the start of a round, so this has to loose");
    const launched = w.arrows[w.arrows.length - 1].vel.length();
    assert.ok(
      Math.abs(launched - SHOT_SPEED) < 1e-9,
      `a shot has to leave at SHOT_SPEED (${SHOT_SPEED}), which is what every dwell below is measured against — it left at ${launched}`,
    );
  }

  for (const rank of ["near", "far"] as const) {
    // The far corner of the rank: the longest shot a butt standing there can
    // ask for, which is what its dwell has to outlast — not the average one.
    const range = Math.hypot(SPAWN_X_LIMIT, SHOOTER_Z - RANKS[rank].z);
    const elevation = ballisticElevation(range, FACE_HEIGHT - NOCK_HEIGHT, SHOT_SPEED);
    const flight = range / (SHOT_SPEED * Math.cos(elevation));

    assert.ok(Math.abs(longestShotTo(rank) - range) < 1e-9, `${rank} rank: longestShotTo has to be that corner`);
    assert.ok(Math.abs(flightTimeTo(rank) - flight) < 1e-9, `${rank} rank: flightTimeTo has to be that flight`);

    // The floor under every dwell at this rank, and the thing the whole fix
    // rests on: time to react, and then time for the arrow to get there.
    assert.ok(
      Math.abs(minimumDwell(rank) - (AIM_WINDOW + flight)) < 1e-9,
      `${rank} rank: the floor under a dwell has to be the aim window plus the flight, not a number picked to look like one`,
    );

    // And every dwell a butt of this rank can actually be handed clears it —
    // the peek exactly, the green and the red by their own spreads. Driven
    // through the real `dwellFor` over the whole spread rather than argued
    // about, with `rand`'s two ends pinned so "worst case" means worst case.
    assert.ok(
      Math.abs(dwellFor(rank, false, "peek") - (AIM_WINDOW + flight)) < 1e-9,
      `${rank} rank: a peek gets the floor exactly — the reaction and the flight and nothing more`,
    );
    const originalRandom = Math.random;
    try {
      for (const roll of [0, 0.5, 0.999999]) {
        Math.random = () => roll;
        for (const hostile of [false, true]) {
          for (const behaviour of ["stand", "drift", "swing"] as const) {
            const dwell = dwellFor(rank, hostile, behaviour);
            assert.ok(
              dwell > flight,
              `${rank} rank: a ${hostile ? "red" : "green"} ${behaviour} drawing ${roll} gets ${dwell.toFixed(2)}s fully up, which does not outlast the ${flight.toFixed(2)}s an arrow needs to reach it`,
            );
            assert.ok(
              dwell >= AIM_WINDOW + flight - 1e-9,
              `${rank} rank: and it has to leave the player the ${AIM_WINDOW}s aim window on top of the flight, not just beat the arrow`,
            );
            const spread = hostile ? HOSTILE_SPREAD : GREEN_SPREAD;
            assert.ok(
              dwell <= AIM_WINDOW + flight + spread + 1e-9,
              `${rank} rank: and no longer than the floor plus its own ${spread}s spread`,
            );
          }
        }
      }
    } finally {
      Math.random = originalRandom;
    }
  }

  // The far rank is further, so it takes longer to reach and has to stand
  // longer. One shared dwell cannot be right for both, which is what the old
  // single `rand(0.5, 1.2)` and the old flat 1.8s peek each were.
  assert.ok(flightTimeTo("far") > flightTimeTo("near"), "the far rank is the longer shot");
  assert.ok(minimumDwell("far") > minimumDwell("near"), "so a butt standing there has to stay up longer");
  assert.ok(peekWindow("far") > peekWindow("near"), "including the peek, whose window was one number for both ranks");

  // A peek is the fleeting one: the tightest of the three at either rank.
  const originalRandom = Math.random;
  try {
    Math.random = () => 0; // the shortest green and the shortest red of each spread
    for (const rank of ["near", "far"] as const) {
      assert.ok(
        peekWindow(rank) <= dwellFor(rank, false, "stand") && peekWindow(rank) <= dwellFor(rank, true, "stand"),
        `${rank} rank: a peek must stay up no longer than the shortest green or red of the same rank`,
      );
    }
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * "Hangs from a branch and swings through a shallow arc" — a swing that
 * wanders past its own branch is a drift with extra steps. Runs several full
 * periods and checks the offset from its own spawn point never exceeds the
 * real exported amplitude, and that it actually moves rather than sitting
 * dead centre.
 */
test("a swing stays inside its arc", () => {
  const swing = makeButt({ symbol: "EEE", changePct: 1 }, "far", 12, "swing");
  const dt = 1 / 60;
  let maxOffset = 0;
  for (let i = 0; i < 600; i++) {
    stepButt(swing, dt);
    maxOffset = Math.max(maxOffset, Math.abs(swing.x - swing.originX));
  }
  assert.ok(maxOffset <= SWING_AMPLITUDE + 1e-9, `a swing must stay within its own arc, got offset ${maxOffset}`);
  assert.ok(maxOffset > SWING_AMPLITUDE * 0.5, "the swing should actually move through a meaningful arc, not sit still");
});

test("aim assist forgives a near miss in proportion to the error, rather than deciding the ring at spawn", () => {
  const scene = new T.Scene();
  const target = new T.Object3D(); // no geometry: influences steering, never registers a raycast hit
  const distance = 15;
  target.position.set(0, 0, -distance);
  target.userData.arrowTarget = true;
  scene.add(target);

  const speed = 40;
  const fireWithError = (deg: number): Arrow => {
    const rad = (deg * Math.PI) / 180;
    const vel = new T.Vector3(Math.sin(rad), 0, -Math.cos(rad)).multiplyScalar(speed);
    const mesh = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 1.1, 5), new T.MeshBasicMaterial());
    scene.add(mesh);
    return { mesh, vel, life: 6, mine: true, stuck: 0, spin: 0, touch: false };
  };

  const small = fireWithError(0.2);
  const big = fireWithError(2);

  const dt = 1 / 60;
  const steps = Math.ceil(distance / speed / dt) + 5;
  for (let i = 0; i < steps; i++) stepArrows([small], dt, scene, () => {});
  for (let i = 0; i < steps; i++) stepArrows([big], dt, scene, () => {});

  const smallOffset = Math.abs(small.mesh.position.x);
  const bigOffset = Math.abs(big.mesh.position.x);
  assert.ok(
    bigOffset > smallOffset + 0.05,
    `a 2-degree miss (offset ${bigOffset}) should land measurably further off-centre than a 0.2-degree miss (offset ${smallOffset}), not identically`,
  );
});

/*
 * Task 3: a hostile butt must spend the full TELL_MS winding up — the face
 * turning to the player, the rim's glow rising — before it looses, and must
 * not loose a single arrow before that window elapses. This drives the
 * real `World` end to end with `Math.random` pinned to 0 (the same
 * technique the attract-mode test above uses), so it is the real
 * spawn → rise → wind-up → loose path, not a reimplementation of it. A
 * single stock down on the day makes every spawn hostile, so `w.butts[0]`
 * stays the one butt this test tracks — nothing here can remove it from the
 * list before it fires. `winding` (cleared in the same step that actually
 * looses the arrow — see `world.ts`'s firing block) is read directly rather
 * than inferred from `w.arrows.length`, because with `Math.random` pinned
 * this flat every volley comes up at its maximum size, so several other
 * hostile butts are up and firing on their own schedules throughout this
 * window — real, intended behaviour, but noise for a test asking only
 * whether *this* butt fired early.
 */
test("a hostile butt winds up for the full TELL_MS before it looses, and never during it", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0; // deterministic: near rank, x = -30, the shortest dwell and cooldown
    const w = new World(makeNullSurface(), [{ symbol: "DOWN", changePct: -1 }], () => {});
    w.start();
    const dt = 1 / 60;

    let windStart = -1;
    for (let i = 0; i < 300 && windStart < 0; i++) {
      w.step(dt);
      if (w.butts[0]?.winding) windStart = i;
    }
    assert.ok(windStart >= 0, "a hostile butt should have started winding up within the first five seconds");

    // Short of the full TELL_MS: still must be winding, not fired.
    const windFrames = Math.round(TELL_MS / 1000 / dt);
    for (let i = 0; i < windFrames - 3; i++) w.step(dt);
    assert.equal(w.butts[0].winding, true, "the tracked butt must still be winding up just short of the full TELL_MS");
    assert.ok(w.butts[0].windUp < TELL_MS / 1000, "its own elapsed wind-up must not yet have reached TELL_MS");

    // Past it: winding should have cleared, meaning the shot was loosed.
    for (let i = 0; i < 10; i++) w.step(dt);
    assert.equal(w.butts[0].winding, false, "winding should clear the instant the shot is loosed, at TELL_MS and not before");
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * Bug C ("getting hit from targets i can't see in the distance"): the
 * wind-up above is purely visual — the rim's glow and the turn toward the
 * player — and the camera's 36° half field of view against a ±48.7° yaw
 * clamp and a ±30-unit spawn spread meant a red butt could wind up and
 * loose entirely outside what the player could see, with nothing to hear
 * either. `World.step`'s firing block now asks `sfx.tell(distance, pan)`
 * exactly on the transition into a wind-up (`cooldown` running out and
 * `winding` being set), which is what this drives against a fake `sfx` the
 * same way the existing whistle test does, since nothing about the sound
 * itself is otherwise observable from outside `World`.
 *
 * With `Math.random` pinned to 0 several hostile butts wind up over the
 * course of this run (the wind-up test above notes the same thing), so this
 * counts every wind-up-start transition across every butt directly off
 * `winding`, rather than assuming there is only one, and requires the tell
 * to fire exactly that many times: once per wind-up, never once per frame
 * of it, and never skipped.
 */
test("a hostile butt entering its wind-up asks the sound layer for the tell, once per wind-up and never once per frame", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const w = new World(makeNullSurface(), [{ symbol: "DOWN", changePct: -1 }], () => {});
    w.start();
    const calls: { distance: number; pan: number }[] = [];
    w.sfx = {
      loose() {},
      thunk() {},
      miss() {},
      hurt() {},
      chime() {},
      horn() {},
      marker() {},
      whistle() {},
      tell(distance: number, pan: number) {
        calls.push({ distance, pan });
      },
    };
    const dt = 1 / 60;
    const wasWinding = new WeakSet<Butt>();
    let windUpStarts = 0;
    for (let i = 0; i < 300; i++) {
      w.step(dt);
      for (const b of w.butts) {
        if (b.winding) {
          if (!wasWinding.has(b)) {
            windUpStarts++;
            wasWinding.add(b);
          }
        } else {
          wasWinding.delete(b);
        }
      }
    }
    assert.ok(windUpStarts > 0, "at least one hostile butt should have started winding up within five seconds");
    assert.equal(
      calls.length,
      windUpStarts,
      "the tell must fire exactly once per wind-up — not once per frame of it, and not skipped",
    );
    for (const c of calls) {
      assert.ok(
        c.distance > 0 && Number.isFinite(c.distance),
        "the tell's distance must be the winding butt's real distance to the player",
      );
      assert.ok(c.pan >= -1 && c.pan <= 1, "the tell's pan must stay within the stereo range, -1 to 1");
    }
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * "Clamped to ±3 units, easing back to centre on release" — driven through
 * the real `World.setStrafe`/`step`, not the private field it moves,
 * because `sidestep` is the one thing this test is allowed to read (see its
 * own doc comment in world.ts). A green-only stock keeps the round free of
 * hostiles, so nothing else touches health or the camera while this runs.
 */
test("sidestep clamps to ±3 units and eases back to centre on release", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();
  const dt = 1 / 60;

  w.setStrafe(1);
  for (let i = 0; i < 60; i++) w.step(dt); // a full second held — well past the 1/3s a full dodge takes
  assert.equal(w.sidestep, 3, "a held direction should reach the clamp and go no further");
  for (let i = 0; i < 30; i++) w.step(dt); // half a second more, still held
  assert.equal(w.sidestep, 3, "holding past the clamp must not push it any further");

  w.setStrafe(0);
  w.step(dt);
  assert.ok(w.sidestep > 0 && w.sidestep < 3, "releasing should ease back over time, not snap straight to centre");
  for (let i = 0; i < 300; i++) w.step(dt); // five more seconds to settle
  assert.ok(Math.abs(w.sidestep) < 0.01, "given long enough, the ease should return it to centre");

  w.setStrafe(-1);
  for (let i = 0; i < 60; i++) w.step(dt);
  assert.equal(w.sidestep, -3, "the clamp holds on the other side too");
});

/*
 * The escape arithmetic, proven rather than only argued: `stepArrows`
 * checks the player's *current* position every frame a hostile arrow is in
 * flight, not just where it was aimed at the moment it launched — so a
 * player who is still moving when the arrow arrives is judged against where
 * they actually are, not where they stood when it left the string. This
 * fires the real `looseEnemyArrow` at both ranks with `Math.random` pinned
 * to 1, which sends `rand(34, 42)` to its *maximum* — the fastest roll, the
 * shortest flight, and so the least time the player has to clear it. (A
 * slower arrow only gives a dodge more room; the tight case is the fast
 * one, which the escape-arithmetic table in the task report identifies as
 * the near rank at 42 m/s — 1.007s of flight, against the 0.333s a full
 * sidestep takes.) Each rank drives the real `stepArrows` twice: once with
 * the player never moving — which must still connect, guarding the exact
 * defect Phase 1 shipped, a hostile arrow that could not hit the player at
 * all — and once with the player moving at `World`'s own sidestep rate from
 * the instant it launches, which must not. Looping both ranks (rather than
 * only the tighter one) also covers the far rank's longer range and larger
 * elevation, and so a different point on the `asin` clamp, which a single
 * pinned configuration would otherwise leave unexercised.
 */
test("a player sidestepping during a hostile arrow's flight clears it; one who stands still is hit — at both ranks", () => {
  const fireAndFly = (rankZ: number, move: (elapsed: number, player: T.Object3D) => void): boolean => {
    const scene = new T.Scene();
    const player = new T.Object3D();
    const at = new T.Vector3(0, 3.6, 20);
    player.position.copy(at);
    player.userData.isPlayer = true;
    scene.add(player);

    const group = new T.Group();
    group.position.set(0, 0, rankZ);
    const fakeButt = { group } as unknown as import("../src/app/(site)/range/butts").Butt;
    const arrow = looseEnemyArrow(scene, fakeButt, at);
    const arrows: Arrow[] = [arrow];

    let hitPlayer = false;
    const dt = 1 / 60;
    let elapsed = 0;
    for (let i = 0; i < 300 && arrows.length && !hitPlayer; i++) {
      elapsed += dt;
      move(elapsed, player);
      stepArrows(arrows, dt, scene, (_a, hit) => {
        if (hit === player) hitPlayer = true;
      });
    }
    return hitPlayer;
  };

  const originalRandom = Math.random;
  try {
    Math.random = () => 1; // the fast end of the speed range (42 m/s) — the shortest flight, the tightest case for the dodge to clear
    for (const [label, rankZ] of [
      ["near", RANKS.near.z],
      ["far", RANKS.far.z],
    ] as const) {
      const stayed = fireAndFly(rankZ, () => {});
      // World's own SIDESTEP_SPEED (9 units/s) and SIDESTEP_MAX (3), reproduced
      // here rather than imported — an internal tuning constant of `World`,
      // not part of the `arrows` module this test drives directly.
      const dodged = fireAndFly(rankZ, (elapsed, player) => {
        player.position.x = Math.min(3, elapsed * 9);
      });
      assert.ok(stayed, `${label} rank: a stationary player should still be hit — the exact regression Phase 1's zero-hit bug guards against`);
      assert.ok(!dodged, `${label} rank: a player sidestepping at the game's own rate should be clear of the fastest arrow by the time it arrives`);
    }
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * The full path, end to end through the real `World`: spawn, wind-up, loose,
 * flight, and a credited hit that actually moves `health` — the same guard
 * the test above proves at the ballistics level, but here nothing about the
 * new wind-up gate is allowed to have quietly broken the connection between
 * a hostile butt existing and a hit eventually landing.
 */
test("a telegraphed hostile arrow still reaches the player, driven end to end through the real World", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const w = new World(makeNullSurface(), [{ symbol: "DOWN", changePct: -1 }], () => {});
    w.start();
    const dt = 1 / 60;
    const startHealth = w.health;
    let hit = false;
    for (let i = 0; i < 600 && !hit; i++) {
      w.step(dt);
      if (w.health < startHealth) hit = true;
    }
    assert.ok(hit, "a telegraphed hostile arrow should eventually connect with the player within ten seconds");
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * `whistle` gets its first caller here: `World.step` calls it every frame a
 * hostile arrow is in flight with that arrow's real, current distance to
 * the player, not a fixed sweep timed from when it launched. A fake `sfx`
 * records what it was called with, which is the only way to see that from
 * outside `World` — nothing about the distance itself is otherwise
 * observable.
 */
test("the incoming whistle is driven by the arrow's real distance, falling as it closes", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const w = new World(makeNullSurface(), [{ symbol: "DOWN", changePct: -1 }], () => {});
    w.start();
    const distances: number[] = [];
    w.sfx = {
      loose() {},
      thunk() {},
      miss() {},
      hurt() {},
      chime() {},
      horn() {},
      marker() {},
      whistle(d: number) {
        distances.push(d);
      },
    };
    const dt = 1 / 60;
    for (let i = 0; i < 250 && !(w.arrows.length && w.arrows[0].stuck > 0); i++) w.step(dt);

    assert.ok(distances.length > 5, "the whistle should be called repeatedly over the arrow's flight, not once");
    const first = distances[0];
    const last = distances[distances.length - 1];
    assert.ok(last < first, `distance should fall as the arrow closes: first ${first}, last ${last}`);
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * Task 4: the round's pacing, `waveAt(elapsedMs)`, at the six moments the
 * brief names — 0, 19s and 21s either side of the wave 0/1 seam, 44s and 46s
 * either side of the wave 1/2 seam, and 59s deep in the storm. `waveAt` is
 * specified as a pure function of elapsed time with no state of its own, so
 * every one of these is a fresh, independent call rather than a sequence
 * that has to be stepped through — the whole point of the seam is that a
 * test can ask about second 46 without living through the 46 seconds before
 * it.
 */
test("waveAt reports the three bands at the spec's own boundaries", () => {
  assert.equal(waveAt(0).wave, 0, "the round opens in wave 0");
  assert.equal(waveAt(19_000).wave, 0, "19s is still inside the 0-20s band");
  assert.equal(waveAt(21_000).wave, 1, "21s has crossed into the 20-45s band");
  assert.equal(waveAt(44_000).wave, 1, "44s is still inside the 20-45s band");
  assert.equal(waveAt(46_000).wave, 2, "46s has crossed into the 45-60s band");
  assert.equal(waveAt(59_000).wave, 2, "59s is deep in the storm");
});

/*
 * The literal numbers matter less than the shape: a retune that nudges
 * `maxUp` from 9 to 8, say, should not fail this suite, but a retune that
 * silently inverts the curve — wave 2 calmer than wave 0 — must. So this
 * asserts the *relationships* `waveAt`'s own doc comment promises (`maxUp`
 * and `hostileShare` rising band over band, `spawnEvery` falling) rather
 * than pinning today's exact literals, using the same six moments as the
 * boundary test above so both tests are reasoning about the same bands.
 */
test("maxUp and hostileShare climb band over band while spawnEvery falls", () => {
  const w0 = waveAt(0);
  const w1 = waveAt(21_000);
  const w2 = waveAt(46_000);

  assert.ok(w0.maxUp < w1.maxUp, `maxUp should rise from wave 0 (${w0.maxUp}) to wave 1 (${w1.maxUp})`);
  assert.ok(w1.maxUp < w2.maxUp, `maxUp should rise from wave 1 (${w1.maxUp}) to wave 2 (${w2.maxUp})`);

  assert.ok(
    w0.hostileShare < w1.hostileShare,
    `hostileShare should rise from wave 0 (${w0.hostileShare}) to wave 1 (${w1.hostileShare})`,
  );
  assert.ok(
    w1.hostileShare < w2.hostileShare,
    `hostileShare should rise from wave 1 (${w1.hostileShare}) to wave 2 (${w2.hostileShare})`,
  );

  assert.ok(
    w0.spawnEvery > w1.spawnEvery,
    `spawnEvery should fall from wave 0 (${w0.spawnEvery}) to wave 1 (${w1.spawnEvery})`,
  );
  assert.ok(
    w1.spawnEvery > w2.spawnEvery,
    `spawnEvery should fall from wave 1 (${w1.spawnEvery}) to wave 2 (${w2.spawnEvery})`,
  );

  // Wave 0 must still hold to the spec's own "at most one" red: rounding
  // maxUp * hostileShare to the nearest whole target — the same arithmetic
  // world.ts's hostile cap uses — must land on exactly one, not zero (no red
  // at all, too calm) and not two (no longer "at most one").
  assert.equal(
    Math.round(w0.maxUp * w0.hostileShare),
    1,
    "wave 0's maxUp and hostileShare together should cap at exactly one red up at once",
  );
});

/*
 * `waveAt` is documented as stateless — no clock of its own, nothing
 * mutated between calls — which is what makes the two tests above valid as
 * independent, any-order assertions rather than a sequence that has to be
 * replayed in order. Proven directly: calling it out of order, and calling
 * it on the same instant twice in a row, must both answer identically to
 * calling it once, in order.
 */
test("waveAt is a pure function of elapsed time, not a stepped clock", () => {
  const outOfOrder = waveAt(46_000);
  const again = waveAt(21_000);
  assert.deepEqual(outOfOrder, waveAt(46_000), "asking about 46s twice, with an unrelated call between, must agree");
  assert.deepEqual(again, waveAt(21_000), "asking about 21s after 46s must match asking about 21s cold");
  assert.deepEqual(waveAt(0), waveAt(0), "the same instant always answers the same way");
});

/*
 * The music tightening `World.step` cues via `Sfx.setWave` (sfx.ts) — no one
 * on this project can hear whether it actually sounds tighter, so this
 * checks the number the tightening is built from instead, the same way
 * `sfx.ts`'s own doc comment on `musicRateForWave` says to: wave 2 must play
 * measurably faster than waves 0 and 1, and the concrete, arithmetic
 * consequences of that — the loop's root partial rising in pitch and the
 * whole 8-second buffer being read in less real time — are worked out here
 * rather than only asserted as "higher".
 */
test("the music loop's playback rate tightens only in wave 2, and by a measurable margin", () => {
  assert.equal(musicRateForWave(0), musicRateForWave(1), "waves 0 and 1 should share the same, untightened rate");
  assert.ok(musicRateForWave(2) > musicRateForWave(1), "wave 2's rate must exceed wave 1's rate");
  assert.ok(
    musicRateForWave(2) - musicRateForWave(1) > 0.05,
    "the wave 2 rate should differ by a real margin, not by floating-point noise",
  );

  // The root partial (55Hz, per sfx.ts's DRONE_PARTIALS) and the loop's own
  // 8-second length, both scaled by the tightened rate — the concrete,
  // audible-if-anyone-could-hear-it consequence of the number above.
  const LOOP_ROOT_HZ = 55;
  const LOOP_SECONDS = 8;
  const tightenedRoot = LOOP_ROOT_HZ * musicRateForWave(2);
  const tightenedLoopSeconds = LOOP_SECONDS / musicRateForWave(2);
  assert.ok(tightenedRoot > LOOP_ROOT_HZ, `the root partial should climb above ${LOOP_ROOT_HZ}Hz, not just the rate number`);
  assert.ok(
    tightenedLoopSeconds < LOOP_SECONDS,
    `the loop should complete in under ${LOOP_SECONDS}s once tightened, not just play at a different number`,
  );
});

/*
 * Round 1 review finding: `waveAt`'s own "at most one red in wave 0" was
 * only ever proven as arithmetic (`Math.round(maxUp * hostileShare) === 1`
 * in the ordering test above) — never as something `World.spawn` actually
 * enforces frame to frame. This drives a real, mixed-stock round (several
 * green, one red, so a genuine choice exists every spawn) through the whole
 * of wave 0 and checks the live headcount directly against `w.butts`,
 * rather than trusting that the arithmetic and the code agree.
 */
test("the wave 0 hostile cap holds live, not just as arithmetic in waves.ts", () => {
  const originalRandom = Math.random;
  try {
    // Pinned to 0, the same technique the pre-existing wind-up and whistle
    // tests use: with `Math.random() < wave.hostileShare * 1.4` always true,
    // every spawn that still has hostile room *will* want to be hostile —
    // the bias is maxed out, not left to chance, so a cap that held only
    // because the dice never asked for a second red would not fool this.
    Math.random = () => 0;
    const stocks = [
      { symbol: "AAA", changePct: 4 },
      { symbol: "BBB", changePct: 2 },
      { symbol: "CCC", changePct: 1 },
      { symbol: "DDD", changePct: 3 },
      { symbol: "EEE", changePct: -3 }, // the one red ticker on an otherwise green day
    ];
    const WAVE_0_MAX_UP = waveAt(0).maxUp;
    const w = new World(makeNullSurface(), stocks, () => {});
    w.start();
    const dt = 1 / 60;
    let maxHostileSeen = 0;

    // 15s, comfortably inside wave 0's 0-20s band the whole way.
    for (let i = 0; i < 15 * 60; i++) {
      w.step(dt);
      const activeHostile = w.butts.filter((b) => b.dead === 0 && b.hostile).length;
      maxHostileSeen = Math.max(maxHostileSeen, activeHostile);
      assert.ok(
        activeHostile <= 1,
        `wave 0 must never show more than one live red target on a day green stocks are available (saw ${activeHostile} at frame ${i})`,
      );
    }
    assert.equal(
      maxHostileSeen,
      1,
      "with the hostile bias maxed out and a red ticker available, the cap should actually have been reached, not merely never exceeded",
    );
    // The range should still have filled to its normal ceiling — the cap
    // stops at one *red*, not at one target overall; green fills the rest.
    const activeUp = w.butts.filter((b) => b.dead === 0).length;
    assert.equal(activeUp, WAVE_0_MAX_UP, "green stocks were available, so the range should still fill to wave 0's own maxUp");
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * Round 1 review finding, the actual bug: on a day every tracked ticker is
 * down, `spawn`'s old fallback (`up.length ? up : this.stocks`) reached for
 * the unfiltered stock list the instant the hostile bias rolled against a
 * red pick, which is entirely red on an all-red day — silently bypassing
 * `hostileRoom` and letting wave 0 fill with more than the "at most one"
 * the spec promises. The fix does not restore that cap unconditionally
 * (see `spawn`'s own comment on `allRedDay`): a hard cap of one on a day
 * with zero green stocks would leave wave 0 with at most one *target* on
 * the whole range. So this test checks the deliberate replacement instead:
 * the cap is allowed to rise to `wave.maxUp` on such a day, every target
 * that does appear is honestly red (never a down ticker painted green to
 * manufacture a "safe" shot), and the range still fills rather than sitting
 * near-empty.
 */
test("an all-red day bends the wave 0 hostile cap on purpose, up to maxUp, and never past it", () => {
  const originalRandom = Math.random;
  try {
    // Pinned for the same reason as the test above: with no green stock at
    // all, `wantHostile`'s `up.length === 0` arm is already forced true, so
    // this mainly keeps the rest of `spawn` (rank, x, the stock index into
    // a one-element `down` pool) deterministic rather than adding anything
    // new to what pinning proves here.
    Math.random = () => 0;
    const stocks = [
      { symbol: "AAA", changePct: -4 },
      { symbol: "BBB", changePct: -2 },
      { symbol: "CCC", changePct: -1 },
      { symbol: "DDD", changePct: -3 },
      { symbol: "EEE", changePct: -0.5 },
    ];
    const WAVE_0_MAX_UP = waveAt(0).maxUp;
    const w = new World(makeNullSurface(), stocks, () => {});
    w.start();
    const dt = 1 / 60;
    let maxHostileSeen = 0;

    for (let i = 0; i < 15 * 60; i++) {
      w.step(dt);
      const live = w.butts.filter((b) => b.dead === 0);
      const activeHostile = live.filter((b) => b.hostile).length;
      maxHostileSeen = Math.max(maxHostileSeen, activeHostile);
      assert.ok(
        live.every((b) => b.hostile),
        "every live target on an all-red day must actually be hostile — no down ticker should be painted green to manufacture a safe shot",
      );
      assert.ok(
        activeHostile <= WAVE_0_MAX_UP,
        `the bent cap must still stop at wave 0's own maxUp (${WAVE_0_MAX_UP}), not spawn without limit (saw ${activeHostile} at frame ${i})`,
      );
    }
    assert.ok(
      maxHostileSeen > 1,
      `an all-red day should be allowed past the normal "at most one" cap (saw a peak of only ${maxHostileSeen})`,
    );
    assert.equal(
      maxHostileSeen,
      WAVE_0_MAX_UP,
      `the range should fill all the way to wave 0's own maxUp (${WAVE_0_MAX_UP}) rather than stopping short of it`,
    );
  } finally {
    Math.random = originalRandom;
  }
});

/*
 * The same day, in front of the menu instead of in a round.
 *
 * Attract mode drew from the green stocks only, and returned without
 * raising anything at all when there were none — so a market-wide selloff,
 * which is real data and the day this game is most topical, put a visitor's
 * first sight of the range in an empty wood. Measured: 0 butts in 40
 * simulated seconds against 31 on a mixed day.
 *
 * The filter was protecting nothing here, and the second half of this test
 * is why: `hostileActive` is false for the whole of attract mode, so a red
 * butt on the menu cannot wind up, cannot loose, and has no score or health
 * to take. Both halves matter — raising reds would be the wrong fix if any
 * of them could shoot.
 */
test("attract mode fills the range on an all-red day, and nothing it raises can shoot", () => {
  const dt = 1 / 60;
  const allRed = [
    { symbol: "AAA", changePct: -4 },
    { symbol: "BBB", changePct: -2 },
  ];
  const mixed = [
    { symbol: "UPP", changePct: 3 },
    { symbol: "DWN", changePct: -3 },
  ];

  const attractFor = (stocks: { symbol: string; changePct: number }[]) => {
    const w = new World(makeNullSurface(), stocks, () => {});
    w.attract();
    const raised = new Set<unknown>();
    let hostileArrows = 0;
    let windingUp = 0;
    for (let i = 0; i < 40 * 60; i++) {
      w.step(dt);
      for (const b of w.butts) raised.add(b);
      hostileArrows += w.arrows.filter((a) => !a.mine).length;
      windingUp += w.butts.filter((b) => b.winding).length;
    }
    return { raised: raised.size, hostileArrows, windingUp };
  };

  const red = attractFor(allRed);
  const both = attractFor(mixed);
  assert.ok(both.raised > 0, "a mixed day should raise targets on the menu, or this test proves nothing");
  assert.ok(
    red.raised > 0,
    "an all-red day must raise targets on the menu too — the green filter has nothing to protect in attract mode",
  );
  assert.equal(red.hostileArrows, 0, "nothing raised in attract mode may ever loose an arrow");
  assert.equal(red.windingUp, 0, "nor even begin the wind-up that would precede one");
});

/*
 * Task 5: slow motion at the round's end.
 *
 * `endingGate` is the one place the whole feature's timing lives — a pure
 * function of the clock and whether a player arrow is still flying, the same
 * seam `attractStep` and `waveAt` already proved out for the rest of the
 * round's rules. Three branches: normal speed with time on the clock, the
 * quarter-speed "last two seconds" tail when nothing is in the air, and the
 * quarter-speed wait for a last arrow that is still in the air once the
 * clock has already run out. `timeUp` is deliberately not simply "msLeft <=
 * 0" read back out — it is what `world.ts` uses to decide whether it may
 * still finalise the round this frame (see the `world.ts` acceptance tests
 * below), so it has to come from here, not be re-derived at the call site.
 */
test("endingGate: normal speed with real time left and something in the air", () => {
  const g = endingGate({ msLeft: FINAL_STRETCH_MS + 1, arrowInFlight: true, reducedMotion: false , dying: false });
  assert.equal(g.timeScale, 1);
  assert.equal(g.timeUp, false);
});

test("endingGate: the last two seconds slow down, but only with nothing in the air", () => {
  const nothingFlying = endingGate({ msLeft: FINAL_STRETCH_MS, arrowInFlight: false, reducedMotion: false , dying: false });
  assert.equal(nothingFlying.timeScale, SLOW_MOTION_SCALE, "the tail should run at the spec's own 0.25x");
  assert.equal(nothingFlying.timeUp, false, "the clock has not actually run out yet");

  const stillFlying = endingGate({ msLeft: FINAL_STRETCH_MS, arrowInFlight: true, reducedMotion: false , dying: false });
  assert.equal(
    stillFlying.timeScale,
    1,
    "a shot already in the air keeps the last two seconds at normal speed — the wait is for the clock hitting zero, not this",
  );
});

test("endingGate: time run out with the last arrow still up waits at quarter speed rather than ending", () => {
  const g = endingGate({ msLeft: 0, arrowInFlight: true, reducedMotion: false , dying: false });
  assert.equal(g.timeScale, SLOW_MOTION_SCALE);
  assert.equal(g.timeUp, true);

  const negative = endingGate({ msLeft: -40, arrowInFlight: true, reducedMotion: false , dying: false });
  assert.equal(negative.timeUp, true, "a clock already past zero must still count as time being up");
});

test("endingGate: time run out with nothing in the air is simply over, at normal speed", () => {
  const g = endingGate({ msLeft: 0, arrowInFlight: false, reducedMotion: false , dying: false });
  assert.equal(g.timeScale, 1, "nothing is being followed out, so there is nothing left to slow down for");
  assert.equal(g.timeUp, true);
});

/*
 * The spec's Failure table, as amended: reduced motion takes the last
 * arrow's slow-motion camera out and leaves the clock's own last two
 * seconds alone. The tail is the one branch the player is still shooting
 * in, and the shot-count test further down is why it may not move with the
 * setting; here it is only that the two branches are told apart at all.
 *
 * Off must not mean broken either, so `timeUp` — which is what holds the
 * round open for a last arrow and what refuses new input once the clock has
 * gone — has to come back identical on every branch, gated or not.
 */
test("endingGate: reduced motion takes the last arrow's slow motion out, and only that one", () => {
  const states = [
    { msLeft: 0, arrowInFlight: true },
    { msLeft: FINAL_STRETCH_MS, arrowInFlight: false },
    { msLeft: FINAL_STRETCH_MS + 1, arrowInFlight: true },
    { msLeft: 0, arrowInFlight: false },
  ];
  for (const state of states) {
    const normal = endingGate({ ...state, reducedMotion: false, dying: false });
    const reduced = endingGate({ ...state, reducedMotion: true, dying: false });
    assert.equal(
      reduced.timeUp,
      normal.timeUp,
      `reduced motion must not change whether the round may finish (${JSON.stringify(state)})`,
    );
  }

  assert.equal(
    endingGate({ msLeft: 0, arrowInFlight: true, reducedMotion: true , dying: false }).timeScale,
    1,
    "the last arrow should be followed out at full speed, with no camera sweeping after it",
  );
  assert.equal(
    endingGate({ msLeft: FINAL_STRETCH_MS, arrowInFlight: false, reducedMotion: true , dying: false }).timeScale,
    SLOW_MOTION_SCALE,
    "the last two seconds must stay at quarter speed with the setting on — it is time the player is still shooting in",
  );
});

/*
 * The clock decision this task had to make explicitly: `msLeft` itself runs
 * on real, unscaled time even while everything else in the frame is reading
 * a quarter-speed `dt` — scaling the clock too would hand a slowed ending
 * extra real seconds of play, which is exactly what a round posting to a
 * paid weekly leaderboard cannot afford. This drives the real `World.step`
 * one frame into the "last two seconds, nothing in the air" tail and checks
 * `msLeft` fell by precisely `dt * 1000`, not a quarter of that.
 */
test("the clock itself never slows down, even while the last two seconds of the round do", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();
  w.msLeft = FINAL_STRETCH_MS;
  const dt = 1 / 60;
  w.step(dt);
  assert.ok(
    Math.abs(FINAL_STRETCH_MS - w.msLeft - dt * 1000) < 1e-6,
    `the clock should have fallen by exactly dt*1000 (${dt * 1000}ms), not a slowed fraction of it (fell by ${FINAL_STRETCH_MS - w.msLeft}ms)`,
  );
});

/*
 * The same slow motion actually reaches gameplay, not just the clock's own
 * arithmetic — driven through the real `World.step` and read back off
 * `sidestep`, which moves at an exact, known rate (`SIDESTEP_SPEED`) with no
 * randomness in it, the same property the sidestep-clamp test above already
 * leans on. One world stepped inside the "last two seconds, nothing in the
 * air" tail should move exactly `SLOW_MOTION_SCALE` as far in one real frame
 * as an identical world stepped well before it.
 */
test("with nothing in the air, the last two seconds move the world at exactly the spec's 0.25x", () => {
  const dt = 1 / 60;

  const slowed = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  slowed.start();
  slowed.msLeft = FINAL_STRETCH_MS;
  slowed.setStrafe(1);
  slowed.step(dt);

  const full = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  full.start();
  full.setStrafe(1);
  full.step(dt);

  assert.ok(slowed.sidestep > 0, "the slowed world should still have moved, just less");
  assert.ok(
    Math.abs(slowed.sidestep - full.sidestep * SLOW_MOTION_SCALE) < 1e-9,
    `slowed sidestep (${slowed.sidestep}) should be exactly ${SLOW_MOTION_SCALE} of the full-speed one (${full.sidestep}), not some other fraction`,
  );
});

/*
 * The round's last arrow: the clock running out under a shot still in the
 * air must not cut the round off mid-flight, must not let a second shot
 * sneak out while the first is being followed home, and must still finish
 * the instant that arrow actually resolves — driven through the real
 * `World.start`/`fire`/`step`, not a reimplementation of the state machine.
 * A single up stock keeps the range hostile-free, so nothing but this one
 * shot's own flight decides when the round ends.
 */
test("the round's last arrow is followed out in slow motion instead of being cut off, and buys no second shot", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();
  const dt = 1 / 60;

  assert.ok(w.fire(), "the shot should have loosed");
  assert.equal(w.shots, 1);
  assert.ok(
    w.arrows.some((a) => a.mine && a.stuck === 0),
    "the arrow should still be in flight the instant it is loosed",
  );

  // The clock runs out on the very next frame, with that arrow still up.
  w.msLeft = 1;
  w.step(dt);
  assert.equal(w.msLeft, 0, "the clock clamps at zero and goes no further");
  assert.equal(w.over, false, "the round must not end yet — the last arrow is still being followed");

  // Nothing new can be loosed while the last arrow is being followed out,
  // and clicking away for a full second of frames must not change that.
  assert.equal(w.fire(), false, "no shot should be loosable during the ending sequence");
  for (let i = 0; i < 60; i++) {
    w.fire();
    w.step(dt);
  }
  assert.equal(w.shots, 1, "the ending sequence must not let a second shot be counted");

  // Drive it forward until the arrow actually resolves.
  let steps = 0;
  while (!w.over && steps < 600) {
    w.step(dt);
    steps++;
  }
  assert.ok(w.over, "the round should finish once the last arrow has actually resolved");
  assert.equal(w.shots, 1, "still exactly the one shot that was already in the air when time ran out");
  assert.equal(w.msLeft, 0, "the clock never went negative or ran back up while it waited");
});

/*
 * "The camera following it in" — the one piece of the last-arrow ending
 * that is not otherwise covered by the state-machine test above, which only
 * ever reads `over`/`shots`/`msLeft`. Fires straight ahead (the default
 * aim), so gravity is the one thing pulling the arrow off the view's
 * original line — the view should tilt down to keep tracking it rather
 * than sitting exactly where the shot was loosed from.
 */
test("the camera turns to follow the last arrow while the round waits it out", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();
  const dt = 1 / 60;
  assert.ok(w.fire(), "the shot should have loosed");
  const pitchAtLoose = w.facing.pitch;

  w.msLeft = 1; // the clock runs out with that shot still up
  for (let i = 0; i < 30 && !w.over; i++) w.step(dt);

  assert.ok(
    w.facing.pitch < pitchAtLoose,
    `the view should tilt down to track the falling arrow (pitch went from ${pitchAtLoose} to ${w.facing.pitch})`,
  );
});

/*
 * The ceiling on that wait, and why it is there. A last arrow loosed at the
 * very top of the pitch clamp — `look(0, -9999)` pegs it at +0.28 rad, 16°
 * up — and left to miss everything flies for 3.03 seconds of world time,
 * which at the ending's quarter speed is 12.1 real seconds spent watching an
 * arrow the player already knows has missed. (It was 13.4 while a full draw
 * was reachable and the arrow left at 55 m/s; every shot is `SHOT_DRAW` now,
 * so 49.6 m/s is the longest flight there is.) `ENDING_MAX_S` ends the round instead,
 * and does it without touching the arrow: its `life` is never clamped, so
 * it is still in the air when the card comes up and the scene simply
 * freezes under it, the same as every other path out of a round. The
 * ceiling is checked once a frame, so "inside the cap" means inside it give
 * or take the frame it is checked on.
 */
test("a lofted last arrow cannot hold the round open past the ending's ceiling", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();
  const dt = 1 / 60;

  w.look(0, -9999); // pegged at the top of the pitch clamp: the longest flight there is
  assert.ok(w.fire(), "the shot should have loosed"); // every shot is `SHOT_DRAW`; there is no other

  w.msLeft = 1; // the clock runs out with that shot still climbing
  let seconds = 0;
  while (!w.over && seconds < ENDING_MAX_S * 4) {
    w.step(dt);
    seconds += dt;
  }

  assert.ok(w.over, "the round should have ended rather than waiting the whole flight out");
  assert.ok(
    seconds - ENDING_MAX_S < 2 * dt,
    `the ending should have been cut off at its ceiling (${ENDING_MAX_S}s) — it ran ${seconds.toFixed(2)}s`,
  );
  assert.ok(
    w.arrows.some((a) => a.mine && a.stuck === 0),
    "the arrow should still be in the air: the cap ends the round, it does not cut the arrow's life short",
  );
});

/*
 * The other side of that ceiling, which is the one that would go unnoticed:
 * it has to stay the exception. An ordinary flat shot resolves on its own
 * terms — the arrow lands and sticks, and *that* is what ends the round —
 * comfortably inside `ENDING_MAX_S`. If the cap ever became the ordinary way
 * a round finishes, the ending would be broken in the opposite direction,
 * and this is the assertion that would say so.
 */
test("an ordinary flat last arrow still ends the round on its own terms, well inside the ceiling", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();
  const dt = 1 / 60;

  assert.ok(w.fire(), "the shot should have loosed");

  w.msLeft = 1;
  let seconds = 0;
  while (!w.over && seconds < ENDING_MAX_S * 4) {
    w.step(dt);
    seconds += dt;
  }

  assert.ok(w.over, "the round should have ended");
  assert.ok(
    seconds < ENDING_MAX_S * 0.8,
    `a flat shot should finish well short of the ceiling (${ENDING_MAX_S}s), not be truncated by it — it ran ${seconds.toFixed(2)}s`,
  );
  assert.ok(
    !w.arrows.some((a) => a.mine && a.stuck === 0),
    "nothing of the player's should still be flying: this round ended because its arrow resolved, not because the cap fired",
  );
});

/*
 * With nothing in the air when the clock runs out, there is nothing to
 * follow — the round ends exactly as it always has, no different from
 * before this task.
 */
test("with nothing in the air, the round still ends the instant the clock runs out", () => {
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();
  w.msLeft = 1;
  w.step(1 / 60);
  assert.equal(w.over, true, "with nothing to follow out, the round should end on this same frame");
});

/**
 * Build something with `prefers-reduced-motion: reduce` answering true.
 *
 * `World` reads the setting once, in its constructor, off
 * `window.matchMedia` — so this stands `window` up for exactly the length
 * of that call and puts it back afterwards, whatever happens. It is the
 * real media query the real constructor asks, not an injected flag: the
 * whole point is that this row of the spec's Failure table was missed
 * because nothing ever built a `World` that had asked for it.
 */
function withReducedMotion<R>(on: boolean, build: () => R): R {
  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  const previous = g.window;
  g.window = { matchMedia: (q: string) => ({ matches: on && q.includes("reduce") }) };
  try {
    return build();
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

/*
 * Reduced motion, all the way through a live ending rather than only
 * through `endingGate`'s arithmetic. Three things, because "off" must not
 * come out as "broken":
 *   - the "last two seconds" tail is quarter speed with the setting and
 *     without it alike, measured against an otherwise identical world
 *     nowhere near the end of its round — the branch the flag deliberately
 *     does not reach, since it is time the player is still shooting in;
 *   - the camera does not sweep after the last arrow;
 *   - the round still ends, on that arrow resolving.
 * The speed is read off `sidestep`, which moves at one exact known rate
 * with no randomness in it — the same property the slow-motion test above
 * already leans on.
 */
test("reduced motion: the last two seconds still slow, the camera stays put, and the round still ends", () => {
  const dt = 1 / 60;
  const stock = [{ symbol: "UP", changePct: 1 }];

  const stepOfTheTail = (reduced: boolean) => {
    const w = withReducedMotion(reduced, () => new World(makeNullSurface(), stock, () => {}));
    w.start();
    w.msLeft = FINAL_STRETCH_MS; // the "last two seconds" tail, nothing in the air
    w.setStrafe(1);
    w.step(dt);
    return w.sidestep;
  };
  const reference = (() => {
    const w = new World(makeNullSurface(), stock, () => {});
    w.start();
    w.setStrafe(1);
    w.step(dt); // the same frame, nowhere near the end of the round
    return w.sidestep;
  })();

  assert.ok(
    Math.abs(stepOfTheTail(false) - reference * SLOW_MOTION_SCALE) < 1e-9,
    "without the setting the tail should still be the spec's own quarter speed",
  );
  assert.ok(
    Math.abs(stepOfTheTail(true) - reference * SLOW_MOTION_SCALE) < 1e-9,
    `with the setting on the tail should still be quarter speed (${stepOfTheTail(true)} vs ${reference * SLOW_MOTION_SCALE}) — the flag reaches the last arrow, not this`,
  );

  // The last-arrow ending: the camera, and that the round still finishes.
  const w = withReducedMotion(true, () => new World(makeNullSurface(), stock, () => {}));
  w.start();
  w.look(0, -9999); // the top of the pitch clamp: the longest flight, and the widest sweep
  assert.ok(w.fire(), "the shot should have loosed");
  const aimed = w.facing;
  w.msLeft = 1;
  let seconds = 0;
  while (!w.over && seconds < ENDING_MAX_S * 4) {
    w.step(dt);
    seconds += dt;
  }
  assert.ok(w.over, "the round must still end — reduced motion turns the cinematic off, not the game");
  assert.equal(w.facing.yaw, aimed.yaw, "the view must not have swept sideways after the arrow");
  assert.equal(w.facing.pitch, aimed.pitch, "nor tilted after it");
});

/*
 * The one thing the reduced-motion flag may never do: change the score.
 *
 * `step` feeds the ending's scaled `dt` to the timer that gates a shot —
 * the nock's refill — so whatever scale the "last two seconds" tail runs at
 * decides how many arrows a player can get away inside it. Neutralising that
 * scale for the setting and not against it therefore paid out in shots, and
 * shots are points on a board that pays a prize. Extra shots are the same
 * defect as fewer, so what is asserted here is the relationship and not
 * either count: whatever the game's rate of fire turns out to be, the same
 * two seconds of clock have to allow the same number of them both ways
 * round.
 *
 * Two windows, each exactly `FINAL_STRETCH_MS` of clock wide so they are
 * comparable: one in the middle of the round, which is also what stops the
 * equality being satisfied by a driver that never looses anything at all,
 * and the tail itself.
 *
 * The driver is a player clicking as fast as the game will take it, which
 * since one click is one arrow is now simply calling `fire` every frame:
 * it returns false and costs nothing until the nock allows a shot, so this
 * is the maximum a player could possibly get out of either window.
 */
test("reduced motion cannot change how many shots two seconds of clock allow, at the end or anywhere else", () => {
  const dt = 1 / 60;
  const stock = [{ symbol: "UP", changePct: 1 }];

  const shotsBetween = (reduced: boolean, from: number, to: number) => {
    const w = withReducedMotion(reduced, () => new World(makeNullSurface(), stock, () => {}));
    w.start();
    w.msLeft = from;
    let shots = 0;
    while (w.msLeft > to && !w.over) {
      if (w.fire()) shots += 1;
      w.step(dt);
    }
    return shots;
  };

  const midRound = shotsBetween(false, ROUND_MS, ROUND_MS - FINAL_STRETCH_MS);
  assert.ok(
    midRound > 0,
    "the clicking driver has to be able to loose something in an ordinary two seconds, or every equality below is vacuous",
  );
  assert.equal(
    shotsBetween(true, ROUND_MS, ROUND_MS - FINAL_STRETCH_MS),
    midRound,
    "reduced motion must not change the rate of fire away from the ending either",
  );

  assert.equal(
    shotsBetween(true, FINAL_STRETCH_MS, 0),
    shotsBetween(false, FINAL_STRETCH_MS, 0),
    "the last two seconds must allow a clicking player exactly the same shots with the setting as without it",
  );
});

/*
 * The sidestep across the `ending` boundary, both ways round.
 *
 * `setStrafe` refuses while `ending`. That covers the direction pressed
 * during the ending and misses the one already held when the clock ran
 * out: `strafeInput` kept its value and went on being applied every frame,
 * and since `setStrafe(0)` is refused by the same line, letting the key go
 * could not stop it. A direction held at the buzzer walked the camera all
 * the way to the clamp under a cinematic the player does not aim.
 *
 * Both halves are asserted here, because fixing either one alone still
 * leaves a view the player cannot control.
 */
test("a sidestep held when the clock runs out is let go of, and one pressed during the ending is refused", () => {
  const dt = 1 / 60;
  const stock = [{ symbol: "UP", changePct: 1 }];

  // Held at the buzzer, and released the moment the player notices.
  const held = new World(makeNullSurface(), stock, () => {});
  held.start();
  assert.ok(held.fire(), "the shot should have loosed");
  held.setStrafe(1);
  held.step(dt); // one ordinary frame with the key down, before the clock goes
  const moved = held.sidestep;
  assert.ok(moved > 0, "the dodge should work normally while the round is still running");

  held.msLeft = 1;
  held.step(dt); // the clock runs out here, with the key still down
  held.setStrafe(0); // the player lets go — refused, and it must not matter
  let seconds = 0;
  while (!held.over && seconds < ENDING_MAX_S * 4) {
    held.step(dt);
    seconds += dt;
  }
  assert.ok(
    held.sidestep < moved,
    `a held direction must stop pushing once the ending begins — it went from ${moved} to ${held.sidestep}`,
  );

  // Pressed for the first time during the ending: nothing at all.
  const pressed = new World(makeNullSurface(), stock, () => {});
  pressed.start();
  assert.ok(pressed.fire(), "the shot should have loosed");
  pressed.msLeft = 1;
  pressed.step(dt); // the clock runs out with nothing held
  seconds = 0;
  while (!pressed.over && seconds < ENDING_MAX_S * 4) {
    pressed.setStrafe(-1);
    pressed.step(dt);
    seconds += dt;
  }
  assert.equal(pressed.sidestep, 0, "a direction first pressed during the ending must move nothing");
});

/**
 * Drive a real round until a hostile arrow is well down the range, and hand
 * it back. Every other ending test in this file builds its world from a
 * single up stock — which keeps the range hostile-free, which is right for
 * what those tests are about and is exactly why nothing above ever had an
 * incoming arrow in the air at the buzzer.
 *
 * `travelled` is measured off the arrow's own z at the moment it is first
 * seen rather than against the player's position, which `World` keeps
 * private — the point is only that the shot is properly on its way, not
 * where it has got to.
 */
function aRoundWithAnArrowIncoming(travelled = 28): { w: World; incoming: Arrow } {
  const dt = 1 / 60;
  const w = new World(makeNullSurface(), [{ symbol: "DOWN", changePct: -1 }], () => {});
  w.start();
  let incoming: Arrow | undefined;
  let from = 0;
  for (let i = 0; i < 60 * 45; i++) {
    // Kept alive through the search so that an ordinary mid-round hit is
    // never what one of these tests ends up measuring. Nothing else about
    // the round is touched: the butts, the wind-ups and the shots are all
    // the real ones.
    w.health = 100;
    w.lives = 3;
    w.hurt = 0;
    w.step(dt);
    if (w.over) break;
    if (!incoming) {
      incoming = w.arrows.find((a) => !a.mine && a.stuck === 0);
      if (incoming) from = incoming.mesh.position.z;
      continue;
    }
    if (incoming.stuck > 0 || !w.arrows.includes(incoming)) {
      incoming = undefined; // it landed before it got far enough; wait for the next
      continue;
    }
    if (incoming.mesh.position.z - from >= travelled) return { w, incoming };
  }
  throw new Error("setup: no hostile arrow got well down the range inside 45 simulated seconds");
}

/*
 * The seam the whole suite had switched off: danger meeting the ending.
 *
 * A red butt looses at you and the sixty seconds run out while that arrow
 * is half way down the range. The player can do nothing about it —
 * `setStrafe` refuses for the whole ending, so the dodge is attempted and
 * refused every frame, and the camera is downrange on their own last arrow,
 * so they cannot even see what is coming. So the arrow is frozen where it
 * is: it does not move, and nothing it could have done to the posted score
 * happens. On a board that pays a prize that is correctness, not balance.
 *
 * The assertion is the relationship — the hostile arrow is exactly where it
 * was, the player's own is not — rather than a transcribed distance.
 */
test("a hostile arrow already in the air when the ending begins is frozen and costs the player nothing", () => {
  const dt = 1 / 60;
  const { w, incoming } = aRoundWithAnArrowIncoming();

  assert.ok(w.fire(), "the player's own last arrow should have loosed");
  const mine = w.arrows.find((a) => a.mine && a.stuck === 0);
  assert.ok(mine, "that shot should be in the air");

  w.health = 100;
  w.lives = 3;
  w.hurt = 0;
  w.points = 5000; // above the 250 a hit costs, so a deduction cannot floor away unseen
  const health = w.health;
  const points = w.points;
  const frozenAt = incoming.mesh.position.clone();
  const minesAt = mine.mesh.position.clone();

  w.msLeft = 1; // the clock runs out on the next frame, with both arrows up
  let seconds = 0;
  while (!w.over && seconds < ENDING_MAX_S * 4) {
    // The dodge, attempted on every frame of the ending and no sooner —
    // the ending is the first moment the player could see this coming, and
    // pressing before the buzzer would be testing something else.
    if (w.msLeft === 0) w.setStrafe(1);
    w.step(dt);
    seconds += dt;
  }
  assert.ok(w.over, "the round should still have ended");

  assert.equal(
    incoming.mesh.position.distanceTo(frozenAt),
    0,
    "the hostile arrow should not have moved a millimetre once the ending began",
  );
  assert.equal(incoming.stuck, 0, "and it should not have landed in anything either");
  assert.ok(
    mine.mesh.position.distanceTo(minesAt) > 0,
    "the player's own arrow must still fly — the ending freezes theirs, not yours",
  );
  assert.equal(w.health, health, "no health may be taken during the ending");
  // One-directional on purpose: the player's own last arrow is still
  // resolving and may legitimately score, so the score may rise. Nothing in
  // the ending may take from it, and taking 250 is the only thing a hostile
  // hit does to it. (The combo is left out of this for the same reason in
  // reverse — the player's own arrow missing resets it, so it cannot tell
  // the two causes apart.)
  assert.ok(
    w.points >= points,
    `the ending may only add to the score, never take from it (went from ${points} to ${w.points})`,
  );
  assert.equal(w.sidestep, 0, "the dodge is refused throughout, which is why the freeze has to do the work");
});

/*
 * The death path, end to end. Of the two ways a round can end, the clock
 * running out had eight tests above and this one had none.
 *
 * A player who never moves and never shoots, on an all-red range, is shot
 * until the bar is empty. What `over` leaves behind is the whole assertion:
 * the round is finished, the bar is empty, the clock still has time on it
 * (this ended on health, not on time), the final snapshot went out, and
 * stepping further changes nothing.
 *
 * The count of arrows it takes is the number the menu card states in words,
 * measured here rather than asserted from the outside: 100 health at 18 a
 * hit is six, and the card says six because this says six.
 */
test("the death path ends the round on its own, and what it leaves behind is a finished round", () => {
  const dt = 1 / 60;
  let last: Snapshot | undefined;
  let pushes = 0;
  const w = new World(makeNullSurface(), [{ symbol: "DOWN", changePct: -1 }], (s) => {
    last = s;
    pushes++;
  });
  w.start();

  let health = w.health;
  let taken = 0;
  let seconds = 0;
  while (!w.over && seconds < 60) {
    w.step(dt);
    seconds += dt;
    if (w.health < health) taken++;
    health = w.health;
  }

  assert.ok(w.over, `a passive player should be shot dead inside the round (lasted ${seconds.toFixed(1)}s)`);
  assert.equal(w.health, 0, "the bar is empty, not merely low");
  assert.equal(w.lives, 0, "and the round is out of lives");
  assert.ok(w.msLeft > 0, "this round ended on the health bar — there should be time left on the clock");
  assert.equal(taken, 6, "six hostile arrows empty a full bar at 18 a hit — the number the menu card states");

  assert.ok(pushes > 0 && last, "the final state must have been pushed to the page, not just set on the world");
  assert.equal(last!.over, true, "and that snapshot must say the round is over");
  assert.equal(last!.health, 0);

  const after = pushes;
  const points = w.points;
  w.step(dt);
  w.step(dt);
  assert.equal(pushes, after, "a finished round pushes nothing further");
  assert.equal(w.points, points, "and nothing can still move the posted number");
});

/*
 * "The card carries the whole story" — accuracy and the ring's own name are
 * the two pieces of it that need a formula rather than a straight readout of
 * a snapshot field. Division by zero shots is the one case worth pinning
 * down by hand: a round that ended before a single arrow was ever loosed
 * must read as 0%, not NaN or Infinity on the results card.
 */
test("accuracyPct: zero shots is 0%, not NaN or Infinity", () => {
  assert.equal(accuracyPct(0, 0), 0);
});

test("accuracyPct: hits over shots, rounded to a whole percent", () => {
  assert.equal(accuracyPct(10, 10), 100);
  assert.equal(accuracyPct(1, 3), 33);
  assert.equal(accuracyPct(2, 3), 67);
  assert.equal(accuracyPct(0, 5), 0);
});

test("ringName: the five archery rings by their traditional names, and a fallback for none struck", () => {
  assert.equal(ringName(1), "Gold");
  assert.equal(ringName(2), "Red");
  assert.equal(ringName(3), "Blue");
  assert.equal(ringName(4), "Black");
  assert.equal(ringName(5), "White");
  assert.equal(ringName(0), "—", "0 means nothing has been struck yet, per bestRing's own doc comment");
});

/*
 * ── the share card ───────────────────────────────────────────────────────
 *
 * The image itself is verified in the browser, as every drawing function in
 * this phase is. What is worth pinning here is the text on it: it is the
 * only copy this project produces that leaves the site, so both what it says
 * and what it must never say are properties rather than pixels.
 */

/** One round to vary from, so each test below changes the one field it is
    about rather than restating six numbers. */
const aRun = (over: Partial<Run> = {}): Run => ({
  points: 3420,
  hits: 12,
  shots: 20,
  streak: 5,
  bestRing: 1,
  bestSymbol: "NVDA",
  ...over,
});

test("shareLines: the card's own three lines, in the card's own order", () => {
  const lines = shareLines(aRun());
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "12 hits from 20 shots · 60% accuracy");
  assert.equal(lines[1], "Longest streak 5 · best ring Gold");
  assert.equal(lines[2], "Best ticker NVDA");
});

/*
 * The whole reason this task was told to reuse `accuracyPct` rather than
 * write the division again. A round can end before a single arrow is
 * loosed — the clock simply runs out — and the card someone posts is the
 * worst possible place to find "NaN% accuracy".
 */
test("shareLines: a round with no shots reads as 0%, never NaN or Infinity", () => {
  const line = shareLines(aRun({ points: 0, hits: 0, shots: 0, streak: 0, bestRing: 0, bestSymbol: "" }))[0];
  assert.equal(line, "0 hits from 0 shots · 0% accuracy");
  assert.ok(!/NaN|Infinity/.test(line), "the posted card must not carry a division by zero");
});

/*
 * Same rule the results card follows (see page.tsx): a round that landed no
 * hits never set a best ticker, so the line is absent rather than empty.
 * Pinned as a relationship — one fewer line than the same run with a symbol
 * — rather than as a transcribed count.
 */
test("shareLines: no best ticker means no line for one", () => {
  const withSymbol = shareLines(aRun({ bestSymbol: "NVDA" }));
  const without = shareLines(aRun({ bestSymbol: "" }));
  assert.equal(without.length, withSymbol.length - 1);
  assert.ok(!without.some((l) => l.startsWith("Best ticker")));
});

/*
 * `bestRing` 0 is "nothing struck yet", and the card reads it through
 * `ringName`. The point of the assertion is that the two agree, not that
 * the em-dash is spelt one particular way.
 */
test("shareLines: the ring is named by ringName, including when none was struck", () => {
  assert.ok(shareLines(aRun({ bestRing: 3 }))[1].endsWith(ringName(3)));
  assert.ok(shareLines(aRun({ bestRing: 0 }))[1].endsWith(ringName(0)));
});

test("shareText: the score, the round and where it was played", () => {
  const text = shareText(aRun());
  assert.match(text, /3,420/);
  assert.match(text, /12 hits from 20 shots/);
  assert.match(text, /60% accuracy/);
  assert.match(text, /ponsnipe\.com/);
});

test("shareText: zero shots is 0% here too, on the copy that travels furthest", () => {
  const text = shareText(aRun({ points: 0, hits: 0, shots: 0 }));
  assert.match(text, /0% accuracy/);
  assert.ok(!/NaN|Infinity/.test(text));
});

/*
 * docs/POSTS.md's second rule — never imply a return — applied to the one
 * piece of copy a player can paste anywhere. The site charges a trading fee
 * and the board pays a prize, so a line that reads as a promise of winnings
 * is a liability rather than a matter of tone. This is a guard against the
 * copy being "improved" later, so it is written against the vocabulary of a
 * promise rather than against today's exact sentence.
 */
test("shareText: says nothing about money, winning or a prize", () => {
  for (const run of [aRun(), aRun({ points: 0, hits: 0, shots: 0, bestSymbol: "" })]) {
    const text = shareText(run).toLowerCase();
    for (const word of ["profit", "return", "earn", "win", "won", "prize", "payout", "$", "money", "rich"]) {
      assert.ok(!text.includes(word), `share text must not say "${word}": ${text}`);
    }
  }
});

/*
 * The ticker is on the image but deliberately not in this text. The image
 * frames it — a painted archery range with a score on it — and the text can
 * be pasted on its own, where a ticker beside a large number reads as a tip.
 */
test("shareText: names no ticker, however the round went", () => {
  assert.ok(!shareText(aRun({ bestSymbol: "NVDA" })).includes("NVDA"));
});

/*
 * The share image has to look like the game, and it is the only thing the
 * range produces that travels beyond the site. It used to hand-copy nine
 * values out of `scene.ts` — four sky stops, three albedos, the fog and the
 * sun — with the provenance written in prose and no import at all, so a
 * retune of the wood would have left the image painting a wood that no
 * longer exists and nothing anywhere would have noticed.
 *
 * Every assertion below is the relationship, never the hex. Transcribing
 * the values here would just be a third copy of them.
 */
test("the share image's sky, fog and sun are scene.ts's own, not a copy of them", () => {
  assert.deepEqual(
    [...SKY_STOPS],
    [SKY_TOP, SKY_MID, SKY_HOT, SKY_HORIZON],
    "the stops the image paints the sky with are scene.ts's stops, in scene.ts's order",
  );
  assert.equal(HAZE, rgbTriplet(FOG_COLOUR), "the haze is scene.ts's fog colour");
  assert.equal(SUN, rgbTriplet(SUN_COLOUR), "the sun on the image is scene.ts's sun colour");
});

/*
 * The other three cannot be imported: what the image paints is a screen
 * colour, the product of the sun, the ambient, the fog and ACES tone
 * mapping, read back off the running renderer. There is no expression of an
 * albedo that produces one. So `share.ts` records which albedo each sample
 * was taken against, and this is the alarm: if the wood is retuned, these
 * samples are stale and the frame needs reading back again. Failing here
 * does not mean a sample is wrong — it means nobody has looked since.
 */
test("the albedos the share image sampled against are still scene.ts's albedos", () => {
  assert.equal(SAMPLED_AGAINST.ground, GROUND_ALBEDO, "the ground silhouette");
  assert.equal(SAMPLED_AGAINST.oakLeaf, OAK_LEAF_ALBEDO, "the tree mass");
  assert.equal(SAMPLED_AGAINST.palisade, PALISADE_ALBEDO, "the palisade, lit face and shaded");
  assert.equal(
    SAMPLED_AGAINST.sunAngleDeg,
    SUN_ANGLE_DEG,
    "the sun's disc is placed by eye for this elevation — move the sun and it needs placing again",
  );
});

/*
 * "The bow is shooting way too high, especially the further targets."
 *
 * It was not. Measured across 642 dead-centre shots, not one arrow flew high
 * over a target that was still standing — every single miss was the butt
 * ducking back into cover while the shot was crossing to it, so the shaft
 * sailed over the empty spot where it had been. That reads to a player as
 * the bow shooting high, and it reads worst at the far rank, whose 1.37s
 * flight gives the duck half again the room the near rank's 0.86s does.
 *
 * `Butt.held` is the answer: a target does not duck out from under a shot
 * already committed to it. This drives the real `World` rather than
 * `stepButt` alone, because the thing under test is the wiring — `fire`
 * recording which butt it solved onto, and `step` clearing the flag from the
 * live arrow list every frame.
 */
test("a target does not duck while one of the player's arrows is crossing to it", () => {
  const dt = 1 / 60;
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();

  let target: import("../src/app/(site)/range/butts").Butt | undefined;
  for (let f = 0; f < 3000 && !target; f++) {
    w.step(dt);
    target = w.butts.find((b) => b.out > 0.99 && b.dead === 0 && b.rising && !b.hostile);
  }
  assert.ok(target, "a butt should have come up to shoot at");

  // Aim dead centre at it and loose, the way the locked/scoped path does.
  const face = target.face.getWorldPosition(new T.Vector3());
  const d = face.clone().sub(w.eye);
  // Turned through `look`, the public path, the same way the lead test above
  // aims — `yaw`/`pitch` are World's own and a test has no business writing
  // them.
  const LOOK_K = 0.0022;
  const yaw = Math.atan2(-d.x, -d.z);
  const pitch = Math.asin(d.y / d.length());
  w.look(-(yaw - w.facing.yaw) / LOOK_K, -(pitch - w.facing.pitch) / LOOK_K);
  assert.ok(
    Math.abs(w.facing.yaw - yaw) < 1e-6 && Math.abs(w.facing.pitch - pitch) < 1e-6,
    "the view has to actually reach the face, or the shot below was never aimed at it",
  );
  assert.ok(w.fire(), "the shot should have loosed");
  const arrow = w.arrows[w.arrows.length - 1];
  assert.equal(arrow.at, target, "the shot should have recorded the butt it was solved onto");

  // Spend its whole dwell and more while the arrow is still crossing. Without
  // the hold this is exactly when it would duck: the flight is over a second
  // and the dwell it had left is not.
  target.dwell = 0.05;
  let flying = 0;
  while (arrow.stuck === 0 && w.arrows.includes(arrow) && flying < 300) {
    w.step(dt);
    flying++;
    assert.ok(
      target.held || target.dead > 0,
      "the butt must stay held for as long as that arrow is in the air",
    );
    assert.ok(
      target.out > 0.9 || target.dead > 0,
      `the butt must not sink while the shot is crossing (out ${target.out.toFixed(2)} after ${flying} frames)`,
    );
  }
  /*
   * The loop above has to have covered a real flight, or it pinned nothing.
   *
   * Derived from `flightTimeTo` rather than a frame count: this said
   * `flying > 30` until the shot speed went from 49.6 to 80 m/s and the
   * shortest flight on the range dropped to about 33 frames, which put a
   * magic number one bad spawn away from failing for no reason. Half the
   * rank's own worst-case flight is well under any real shot and well over
   * zero, and it moves with the speed instead of being re-guessed after it.
   */
  const leastFrames = (flightTimeTo(target.rank) * 0.5) / dt;
  assert.ok(
    flying > leastFrames,
    `the flight should have taken real time (${flying} frames, needed more than ${leastFrames.toFixed(0)}), or this pinned nothing`,
  );

  // And the hold is released the moment the arrow resolves — it holds the
  // dwell, it does not make the butt immortal.
  w.step(dt);
  assert.equal(target.held, false, "the hold must clear as soon as the arrow is no longer in the air");
});

/*
 * The other half: a butt nobody has shot at still ducks on its own clock.
 * Without this the test above passes just as well against a butt that never
 * retires at all, which would be a different bug and a worse one.
 */
test("a target nobody has shot at still ducks on its own clock", () => {
  const dt = 1 / 60;
  const w = new World(makeNullSurface(), [{ symbol: "UP", changePct: 1 }], () => {});
  w.start();

  let target: import("../src/app/(site)/range/butts").Butt | undefined;
  for (let f = 0; f < 3000 && !target; f++) {
    w.step(dt);
    target = w.butts.find((b) => b.out > 0.99 && b.dead === 0 && b.rising && !b.hostile);
  }
  assert.ok(target, "a butt should have come up");

  target.dwell = 0.05;
  for (let f = 0; f < 120 && target.out > 0.05; f++) w.step(dt);
  assert.equal(target.held, false, "nothing was shot at it, so nothing should hold it");
  assert.ok(target.out < 0.9, "it should have gone back into cover on its own");
});

/*
 * "Not getting the ending you described."
 *
 * Because the ending was the clock's alone, and almost no round ends on the
 * clock. Driven passively, 30 rounds out of 30 ended with the sixth arrow
 * taken and none of them ran the timer out — so the slow-motion ending was
 * not rare, it was very nearly unreachable, and the one way out that every
 * player actually meets cut straight to the card on the frame they died.
 *
 * `dying` is the third entry to the ending. This drives the real `World`
 * rather than `endingGate` alone, because what was missing was never the
 * pure function — it was that nothing ever passed it this case.
 */
test("the sixth arrow opens the ending rather than ending the round on the spot", () => {
  const dt = 1 / 60;
  const w = new World(makeNullSurface(), [{ symbol: "DOWN", changePct: -1 }], () => {});
  w.start();
  w.health = 1; // one hit from the end, so the next hostile arrow finishes it

  let framesToDeath = 0;
  while (w.health > 0 && framesToDeath < 4000) {
    w.step(dt);
    framesToDeath++;
  }
  assert.ok(w.health <= 0, "a hostile arrow should have finished the round");
  assert.equal(w.over, false, "the round must NOT be over on the frame the last arrow lands — that is the whole bug");

  // The beat runs, and it is a real one: bounded, and long enough to see.
  let beat = 0;
  while (!w.over && beat < 600) {
    w.step(dt);
    beat++;
  }
  const seconds = beat * dt;
  assert.ok(w.over, "the beat has to end in the results card, not hang");
  assert.ok(
    Math.abs(seconds - DEATH_BEAT_S) < 0.1,
    `the beat should be about DEATH_BEAT_S (${DEATH_BEAT_S}s) of real time — it ran ${seconds.toFixed(2)}s`,
  );
  assert.equal(w.msLeft >= 0, true, "the clock never goes negative on the way out");
});

/*
 * And the beat is the world at quarter speed, not a frozen frame with a
 * wait on it — the same slow motion the clock's own ending uses, and taken
 * out by the same accessibility flag.
 *
 * Asserted on the gate rather than by stepping a `World`: the first attempt
 * at this drove a real round and set `health = 0`, which does not set
 * `lives` — only `onArrowHit` does — so `dying` never became true and the
 * test measured a perfectly ordinary frame while claiming to measure a
 * beat. It passed for the wrong reason until the numbers were printed. The
 * end-to-end wiring is what the test above pins; this pins the decision.
 */
test("endingGate: a death runs at the ending's own slow motion, and reduced motion takes it out", () => {
  // Time still on the clock, nothing in the air: without `dying` this is an
  // ordinary mid-round frame, which is exactly what makes it the right
  // control for what `dying` alone changes.
  const midRound = { msLeft: ROUND_MS / 2, arrowInFlight: false };

  const alive = endingGate({ ...midRound, reducedMotion: false, dying: false });
  assert.equal(alive.timeScale, 1, "the control has to be an ordinary frame, or this compares nothing");
  assert.equal(alive.timeUp, false);

  const dying = endingGate({ ...midRound, reducedMotion: false, dying: true });
  assert.equal(dying.timeScale, SLOW_MOTION_SCALE, "a death runs at the ending's own slow motion");
  assert.equal(dying.timeUp, true, "and the round refuses new input from that frame on");

  const reduced = endingGate({ ...midRound, reducedMotion: true, dying: true });
  assert.equal(reduced.timeScale, 1, "reduced motion takes the slow motion out of a death, as it does the last arrow");
  assert.equal(reduced.timeUp, true, "but the round still ends — off means off, not broken");
});
