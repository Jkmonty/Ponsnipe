import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import {
  drawSpeed,
  assistAngle,
  stepArrows,
  DRAW_MIN_SPEED,
  DRAW_MAX_SPEED,
  type Arrow,
} from "../src/app/(site)/range/arrows";

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
