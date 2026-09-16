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
  comboAfter,
  streakAfter,
  resolveButtHit,
  isTargetable,
  applyButtHit,
  bestSymbolAfter,
  LANES,
  RING_FRACTIONS,
  FACE_RADIUS,
} from "../src/app/(site)/range/butts";
import { nockReady, attractStep } from "../src/app/(site)/range/world";

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
 * real round begins. `step` cannot be driven here (it needs a real WebGL
 * canvas), but the decision it consults, `attractStep`, is a plain function
 * of `{ attracting }` and `dt`, so the decision itself can be proven without
 * one. Each check below is a relationship — frozen vs moving, off vs on,
 * output equal to a named input — rather than a number copied out of a run.
 */
test("attracting turns off exactly the clock, hostiles and hit consequences, and turns them back on once a real round begins", () => {
  const dt = 1 / 60;
  const attracting = attractStep({ attracting: true }, dt);
  const playing = attractStep({ attracting: false }, dt);

  assert.equal(attracting.clockDt, 0, "the round clock must not advance at all while attracting");
  assert.equal(playing.clockDt, dt, "outside attract the clock's own dt should pass straight through");

  assert.equal(attracting.hostileActive, false, "no butt may come up hostile or fire while attracting");
  assert.equal(playing.hostileActive, true, "and both are allowed once a real round begins");

  assert.equal(attracting.consequencesActive, false, "a hit must not be able to change score or health while attracting");
  assert.equal(playing.consequencesActive, true, "and hits are allowed to matter once a real round begins");
});

test("the frozen clock holds for whatever dt a frame hands it, not just a typical one", () => {
  for (const dt of [0, 1 / 240, 1 / 30, 1, 50]) {
    assert.equal(attractStep({ attracting: true }, dt).clockDt, 0, `dt=${dt} should still freeze the clock`);
    assert.equal(attractStep({ attracting: false }, dt).clockDt, dt, `dt=${dt} should pass through unattended`);
  }
});

/*
 * The same decision, driven the way `step` actually drives it: once per
 * simulated frame, folded into a tiny stand-in for the round state it
 * gates. Attracting for ten seconds' worth of frames must leave the clock,
 * the score, the health and a hostile's own cooldown exactly where they
 * started; leaving attract must let all four move. This is the shape of
 * the regression a gate wired up wrong (or forgotten at one call site)
 * would actually produce — a value that quietly kept moving, or one that
 * quietly never could.
 */
test("driving a simulated round through attractStep leaves the clock, score, health and a hostile's cooldown untouched while attracting, and lets a real round move all four", () => {
  function simulate(attracting: boolean, frames: number) {
    let msLeft = 60_000;
    let points = 500;
    let health = 40;
    let cooldown = 0.05; // a hostile mid-volley, about to loose
    const dt = 1 / 60;
    for (let i = 0; i < frames; i++) {
      const gate = attractStep({ attracting }, dt);
      msLeft -= gate.clockDt * 1000;
      if (gate.hostileActive) {
        cooldown -= dt;
        if (cooldown <= 0 && gate.consequencesActive) {
          health -= 18; // a hostile arrow landing on the player
          cooldown = 1;
        }
      }
      if (gate.consequencesActive) points += 10; // stand-in for a credited hit
    }
    return { msLeft, points, health, cooldown };
  }

  const frozen = simulate(true, 600); // ten seconds at 60fps
  assert.equal(frozen.msLeft, 60_000, "the clock must not have moved a millisecond while attracting");
  assert.equal(frozen.points, 500, "score must not have moved while attracting");
  assert.equal(frozen.health, 40, "health must not have dropped while attracting");
  assert.equal(frozen.cooldown, 0.05, "a hostile's cooldown must never tick while attracting, so it never gets the chance to fire");

  const live = simulate(false, 600);
  assert.ok(live.msLeft < 60_000, "outside attract the clock should have run down");
  assert.ok(live.points > 500, "outside attract score should have been free to grow");
  assert.ok(live.health < 40, "outside attract health should have been free to drop");
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
