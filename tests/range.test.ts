import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import {
  drawSpeed,
  drawShake,
  assistAngle,
  stepArrows,
  looseEnemyArrow,
  DRAW_MIN_SPEED,
  DRAW_MAX_SPEED,
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
  PEEK_WINDOW,
  SWING_AMPLITUDE,
  type Behaviour,
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
 * Attract mode spawns real (non-hostile) butts too — the wood is alive
 * before Start, not just green afterward — and building one bakes its
 * ticker onto a canvas texture (`tickerLabel` in butts.ts), which needs a
 * working `document.createElement("canvas")`. This is bare 2D context
 * plumbing so that real drawing can run without throwing; it decides
 * nothing the game decides, the same way the rAF stand-in above only
 * stands in for the browser's scheduler, not for `step` itself.
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

test("a steady draw does not shake, and a long one does", () => {
  assert.equal(drawShake(0), 0);
  assert.equal(drawShake(1.4), 0);
  assert.ok(drawShake(2) > 0, "past the hold limit the arm should wander");
  assert.ok(drawShake(3) > drawShake(2), "and wander further the longer it is held");
});

test("the shake is capped, so a long hold is worse but never hopeless", () => {
  assert.equal(drawShake(3), drawShake(30));
  assert.ok(drawShake(30) <= 0.0175, "one degree is the most it may wander");
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
 * `touchFire` used to call `fire` directly, and `fire`'s own gate
 * (`drawn < 0.5`) was looser than `beginDraw`'s (`drawn < 1`) — a tapping
 * phone could loose a shot every ~210ms against a mouse's own ~525ms.
 * `nockReady` is now the one gate both paths ask, so a value that used to
 * pass the old, looser `fire` threshold must now fail it too.
 */
test("the nock gate is one full pull for a tap and a click alike, not the old half-nock door", () => {
  assert.equal(nockReady(0), false);
  assert.equal(nockReady(0.5), false, "0.5 was fire()'s own old threshold — exactly what let touch fire 2.5x as fast");
  assert.equal(nockReady(0.99), false);
  assert.equal(nockReady(1), true);
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
 */
test("attract mode cannot advance the clock, score, or let anything shoot", () => {
  const w = new World(makeNullSurface(), [
    { symbol: "UP", changePct: +1 },
    { symbol: "DOWN", changePct: -1 },
  ], () => {});
  w.attract();
  const before = { points: w.points, health: w.health, msLeft: w.msLeft };
  let windingUp = 0;
  let hostileArrows = 0;
  for (let i = 0; i < 600; i++) {
    w.step(1 / 60);
    windingUp += w.butts.filter((b) => b.winding).length;
    hostileArrows += w.arrows.filter((a) => !a.mine).length;
  }
  assert.equal(w.points, before.points);
  assert.equal(w.health, before.health);
  assert.equal(w.msLeft, before.msLeft);
  assert.equal(windingUp, 0, "no butt may so much as begin a wind-up while the menu is up");
  assert.equal(hostileArrows, 0, "and none may ever loose an arrow");
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
 * "Rises for 1.8 seconds and drops whether hit or not" — a peek that only
 * ever left the scene when shot would be a drift with extra steps. This
 * drives an unstruck peek past its own window and checks it has started
 * ducking on its own, then drives a struck one through the real
 * `resolveButtHit`/`applyButtHit` hit path and checks the hit takes it out
 * immediately rather than waiting for the window either way.
 */
test("a peek retires within its window whether or not it is hit", () => {
  const dt = 1 / 60;
  const riseTime = 1 / 2.4; // `out` climbs from 0 to 1 at 2.4/s, same rate `stepButt` uses

  const unhit = makeButt({ symbol: "CCC", changePct: 1 }, "near", 0, "peek");
  for (let t = 0; t < riseTime + PEEK_WINDOW + 0.5; t += dt) stepButt(unhit, dt);
  assert.equal(unhit.rising, false, "an unstruck peek must have started ducking within its own window");
  assert.equal(unhit.dead, 0, "it should have left on its own timer, not because anything destroyed it");

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
  const g = endingGate({ msLeft: FINAL_STRETCH_MS + 1, arrowInFlight: true, reducedMotion: false });
  assert.equal(g.timeScale, 1);
  assert.equal(g.timeUp, false);
});

test("endingGate: the last two seconds slow down, but only with nothing in the air", () => {
  const nothingFlying = endingGate({ msLeft: FINAL_STRETCH_MS, arrowInFlight: false, reducedMotion: false });
  assert.equal(nothingFlying.timeScale, SLOW_MOTION_SCALE, "the tail should run at the spec's own 0.25x");
  assert.equal(nothingFlying.timeUp, false, "the clock has not actually run out yet");

  const stillFlying = endingGate({ msLeft: FINAL_STRETCH_MS, arrowInFlight: true, reducedMotion: false });
  assert.equal(
    stillFlying.timeScale,
    1,
    "a shot already in the air keeps the last two seconds at normal speed — the wait is for the clock hitting zero, not this",
  );
});

test("endingGate: time run out with the last arrow still up waits at quarter speed rather than ending", () => {
  const g = endingGate({ msLeft: 0, arrowInFlight: true, reducedMotion: false });
  assert.equal(g.timeScale, SLOW_MOTION_SCALE);
  assert.equal(g.timeUp, true);

  const negative = endingGate({ msLeft: -40, arrowInFlight: true, reducedMotion: false });
  assert.equal(negative.timeUp, true, "a clock already past zero must still count as time being up");
});

test("endingGate: time run out with nothing in the air is simply over, at normal speed", () => {
  const g = endingGate({ msLeft: 0, arrowInFlight: false, reducedMotion: false });
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
    const normal = endingGate({ ...state, reducedMotion: false });
    const reduced = endingGate({ ...state, reducedMotion: true });
    assert.equal(
      reduced.timeUp,
      normal.timeUp,
      `reduced motion must not change whether the round may finish (${JSON.stringify(state)})`,
    );
  }

  assert.equal(
    endingGate({ msLeft: 0, arrowInFlight: true, reducedMotion: true }).timeScale,
    1,
    "the last arrow should be followed out at full speed, with no camera sweeping after it",
  );
  assert.equal(
    endingGate({ msLeft: FINAL_STRETCH_MS, arrowInFlight: false, reducedMotion: true }).timeScale,
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

  // Nothing new can be loosed while the last arrow is being followed out.
  assert.equal(w.fire(), false, "no shot should be loosable during the ending sequence");
  w.beginDraw();
  for (let i = 0; i < 60; i++) w.step(dt);
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
 * up — and left to miss everything flies for 13.4 real seconds before it
 * finally lands, which is thirteen seconds spent watching an arrow the
 * player already knows has missed. `ENDING_MAX_S` ends the round instead,
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
  assert.ok(w.fire(), "the shot should have loosed"); // `fire`'s default draw is a full one

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
 * `step` feeds the ending's scaled `dt` to both timers that gate a shot —
 * the nock's refill and the bow's pull — so whatever scale the "last two
 * seconds" tail runs at decides how many arrows a player can get away
 * inside it. Neutralising that scale for the setting and not against it
 * therefore paid out in shots, and shots are points on a board that pays a
 * prize. Extra shots are the same defect as fewer, so what is asserted here
 * is the relationship and not either count: whatever the game's rate of
 * fire turns out to be, the same two seconds of clock have to allow the
 * same number of them both ways round.
 *
 * Two windows, each exactly `FINAL_STRETCH_MS` of clock wide so they are
 * comparable: one in the middle of the round, which is also what stops the
 * equality being satisfied by a driver that never looses anything at all,
 * and the tail itself.
 *
 * The driver is the full-draw player, the higher-scoring pattern and the
 * one the defect landed on: back on the string the instant the nock allows
 * and let go the instant it is at a full pull. `beginDraw` is a no-op while
 * already drawing or still nocking, so calling it every frame is simply
 * holding the button down. A single up stock keeps the range hostile-free,
 * so nothing but the clock can end either window.
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
      w.beginDraw();
      w.step(dt);
      if (w.pull >= 1 && w.releaseDraw()) shots += 1;
    }
    return shots;
  };

  const midRound = shotsBetween(false, ROUND_MS, ROUND_MS - FINAL_STRETCH_MS);
  assert.ok(
    midRound > 0,
    "the full-draw driver has to be able to loose something in an ordinary two seconds, or every equality below is vacuous",
  );
  assert.equal(
    shotsBetween(true, ROUND_MS, ROUND_MS - FINAL_STRETCH_MS),
    midRound,
    "reduced motion must not change the rate of fire away from the ending either",
  );

  assert.equal(
    shotsBetween(true, FINAL_STRETCH_MS, 0),
    shotsBetween(false, FINAL_STRETCH_MS, 0),
    "the last two seconds must allow a full-draw player exactly the same shots with the setting as without it",
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
