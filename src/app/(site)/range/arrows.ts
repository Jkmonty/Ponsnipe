import * as T from "three";
import type { Butt } from "./butts";
import { HIT_RADIUS } from "./butts";
import { rand } from "./scene";

export interface Arrow {
  mesh: T.Mesh;
  vel: T.Vector3;
  life: number;
  /** True for a shot the player loosed; false for one a butt fired back. */
  mine: boolean;
  /** Seconds it has been stuck in whatever it hit, or 0 while still flying. */
  stuck: number;
  /** Radians per second it rolls about its own shaft, for a nocked-fletching look. */
  spin: number;
  /**
   * True if this shot was fired by a tap rather than a mouse click.
   *
   * A thumb is not a mouse — it is also the thing doing the aiming, so a
   * touch shot needs more help finding its target. Carried on the arrow
   * itself, since `stepArrows` is what actually applies the aim-assist cone
   * and it only has the arrows to consult, not the input that fired them.
   * Absent (or false) for an enemy's own shot, which is never touch-fired.
   */
  touch?: boolean;
}

/** A shaft lying along the view, tip away from you. */
export function makeArrowMesh(): T.Mesh {
  const shaft = new T.Mesh(
    new T.CylinderGeometry(0.012, 0.012, 1.1, 5),
    new T.MeshLambertMaterial({ color: 0xe8d9a8, flatShading: true }),
  );
  shaft.geometry.rotateX(Math.PI / 2);
  return shaft;
}

/** A hostile butt's shot, loosed at `at` — the camera's position. */
export function looseEnemyArrow(scene: T.Scene, b: Butt, at: T.Vector3): Arrow {
  const from = b.group.position.clone().add(new T.Vector3(0, 5.2, 0));
  const to = at.clone();
  const vel = to.sub(from).normalize().multiplyScalar(rand(34, 42));
  // Unlit and pale, because an arrow you cannot see coming is not a
  // challenge, it is just damage arriving.
  const mesh = new T.Mesh(
    new T.CylinderGeometry(0.09, 0.05, 2.2, 4),
    new T.MeshBasicMaterial({ color: 0xffd9a0 }),
  );
  mesh.geometry.rotateX(Math.PI / 2);
  mesh.position.copy(from);
  scene.add(mesh);
  return { mesh, vel, life: 4, mine: false, stuck: 0, spin: rand(2, 5) };
}

/** A full draw sends it flat and fast; a snap shot lobs. */
export const DRAW_MIN_SPEED = 28;
export const DRAW_MAX_SPEED = 55;
export const GRAVITY = 9.8;

/** How long a stuck arrow lingers before it fades out of the scene. */
const STUCK_FADE = 3;
/** No more than this many arrows in flight or stuck at once, oldest first. */
const MAX_ARROWS = 24;
/** A player arrow that hits nothing eventually gives up and is removed. */
export const ARROW_LIFE = 6;

export function drawSpeed(draw: number): number {
  const d = Math.max(0, Math.min(1, draw));
  return DRAW_MIN_SPEED + (DRAW_MAX_SPEED - DRAW_MIN_SPEED) * d;
}

/**
 * How far the aim wanders after holding a full draw too long.
 *
 * Without this, the best play is to hold at full draw forever and loose only
 * on a certainty, which is not archery and is not a game. An archer's arm
 * starts to go after about a second and a half, so this does too.
 */
export function drawShake(heldSeconds: number): number {
  const over = Math.max(0, heldSeconds - 1.4);
  return Math.min(0.0175, over * 0.011);
}

/**
 * How far off a shot may be and still be helped home.
 *
 * The old hitscan snapped any miss inside 2.6 degrees onto the target, which
 * is what stopped the game reading as broken. A flying arrow cannot snap, so
 * it steers instead — the same forgiveness, spent over the flight rather than
 * spent in one instant. A thumb is not a mouse, so touch gets half as much
 * again.
 *
 * 2.6 degrees is not a generous starting point, it is the floor: steering an
 * arrow home over its flight is strictly weaker help than teleporting it onto
 * the target the instant it was loosed, which is what the old hitscan did at
 * this same angle. Anything less than 2.6 here would make hitting a butt
 * harder than the game already shipped with.
 */
export function assistAngle(touch: boolean): number {
  const base = (2.6 * Math.PI) / 180; // 2.6 degrees — see above
  return touch ? base * 1.5 : base; // 3.9 degrees for touch
}

/**
 * Nudge `dir` toward `to`, at most `maxAngle` radians per second, but only
 * while `to` is already within `maxAngle` of where `dir` points.
 *
 * This is steering, not snapping: a shot that already qualifies gets pulled
 * the rest of the way home over its flight, rather than being teleported onto
 * the target the instant it is loosed. Outside the cone nothing happens at
 * all, so a shot that is genuinely wide still misses.
 */
export function steerToward(dir: T.Vector3, to: T.Vector3, maxAngle: number, dt: number): void {
  const angle = dir.angleTo(to);
  if (angle <= 1e-6 || angle > maxAngle) return;
  // Quick relative to the assist angle itself, so a shot that qualifies has
  // time to actually arrive during a normal flight instead of drifting
  // toward the target and running out of road.
  const step = Math.min(angle, maxAngle * 10 * dt);
  const axis = dir.clone().cross(to);
  if (axis.lengthSq() < 1e-9) {
    dir.copy(to);
    return;
  }
  axis.normalize();
  dir.applyAxisAngle(axis, step).normalize();
}

/**
 * Which of a scene's objects an arrow can end its flight in.
 *
 * Tagged at runtime by `world.ts` — a live butt's face with `arrowTarget`,
 * the ground with `arrowGround` — rather than this module reaching into
 * `butts.ts` or `scene.ts` to pick them out of the graph itself.
 */
function collectTargets(scene: T.Scene): { steerable: T.Object3D[]; all: T.Object3D[]; player?: T.Object3D } {
  const steerable: T.Object3D[] = [];
  const all: T.Object3D[] = [];
  let player: T.Object3D | undefined;
  scene.traverse((o) => {
    if (o.userData.arrowTarget) {
      steerable.push(o);
      all.push(o);
    } else if (o.userData.arrowGround) {
      all.push(o);
    } else if (o.userData.isPlayer) {
      player = o;
    }
  });
  return { steerable, all, player };
}

/** Drop an arrow's mesh from the scene and free its GPU-side resources. */
function disposeArrow(scene: T.Scene, mesh: T.Mesh): void {
  scene.remove(mesh);
  mesh.geometry.dispose();
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => m.dispose());
}

/**
 * Advance every arrow one frame: gravity, steering for the player's own
 * shots, movement, spin, and collision against the butts, the ground and
 * (for a hostile shot) the player.
 *
 * One integrator for both sides, player and butt, because they are the same
 * kind of object flying under the same gravity — keeping two loops in sync
 * across a split file is exactly the kind of bug that stays hidden until a
 * volley is on screen.
 *
 * `onHit` fires once per arrow that resolves: a real collision with `hit`
 * being the butt face, the ground, or the player (the scene's camera) it
 * struck, or — for a shot that flew clean past without hitting anything —
 * with `hit` being the scene itself, standing in for "no target". `point`,
 * when given, is where in world space the arrow actually struck — a real
 * object hit always carries one; the ground-swallowed miss cases do not,
 * because there is nothing there worth scoring against a position on.
 */
export function stepArrows(
  arrows: Arrow[],
  dt: number,
  scene: T.Scene,
  onHit: (a: Arrow, hit: T.Object3D, point?: T.Vector3) => void,
): void {
  // Oldest first, so a heavy volley cannot pile the array past the cap. Real
  // flight time keeps far more arrows alive at once than the old instant hit
  // ever did, so this cap gets exercised for real rather than being a
  // theoretical ceiling.
  while (arrows.length > MAX_ARROWS) {
    const a = arrows.shift()!;
    disposeArrow(scene, a.mesh);
  }

  // Positions read below (butts move every frame) must be this frame's,
  // not last frame's — matrixWorld only updates lazily otherwise.
  scene.updateMatrixWorld();
  const { steerable, all, player } = collectTargets(scene);

  for (const a of arrows) {
    if (a.stuck > 0) {
      a.stuck += dt;
      const mat = a.mesh.material as T.Material & { opacity: number; transparent: boolean };
      if (!mat.transparent) {
        mat.transparent = true;
        mat.needsUpdate = true;
      }
      mat.opacity = Math.max(0, 1 - a.stuck / STUCK_FADE);
      continue;
    }

    const before = a.mesh.position.clone();
    a.vel.y -= GRAVITY * dt;

    if (a.mine && steerable.length) {
      const maxAngle = assistAngle(!!a.touch);
      const dir = a.vel.clone().normalize();
      let best: T.Object3D | undefined;
      let bestAngle = maxAngle;
      for (const obj of steerable) {
        const to = obj.getWorldPosition(new T.Vector3()).sub(before);
        if (to.lengthSq() < 1) continue;
        to.normalize();
        const angle = dir.angleTo(to);
        if (angle < bestAngle) {
          bestAngle = angle;
          best = obj;
        }
      }
      if (best) {
        const to = best.getWorldPosition(new T.Vector3()).sub(before).normalize();
        steerToward(dir, to, maxAngle, dt);
        a.vel.copy(dir.multiplyScalar(a.vel.length()));
      }
    }

    a.mesh.position.addScaledVector(a.vel, dt);
    a.mesh.lookAt(a.mesh.position.clone().add(a.vel));
    a.mesh.rotateZ(a.spin * dt);
    a.life -= dt;

    /*
     * Raycast the segment travelled this frame, not the point it ended on.
     *
     * A fast arrow covers several units in one frame, so testing only where
     * it finished lets it tunnel straight through a target between two
     * frames — the same bug the old point-distance check for enemy arrows
     * had already been fixed for once, and would otherwise reappear here.
     */
    const seg = a.mesh.position.clone().sub(before);
    const segLen = seg.length();

    if (!a.mine && player) {
      const p = player.getWorldPosition(new T.Vector3());
      const toP = p.clone().sub(before);
      const len2 = seg.lengthSq() || 1;
      const t = Math.max(0, Math.min(1, toP.dot(seg) / len2));
      const nearPoint = before.clone().addScaledVector(seg, t);
      const near = nearPoint.distanceTo(p);
      if (near < HIT_RADIUS) {
        a.stuck = dt;
        onHit(a, player, nearPoint);
        continue;
      }
    }

    if (segLen > 1e-6 && all.length) {
      const ray = new T.Raycaster(before, seg.clone().normalize(), 0, segLen);
      const hit = ray.intersectObjects(all, false)[0];
      if (hit) {
        const obj = hit.object;
        /*
         * A butt can only be scored once per frame.
         *
         * `steerable`/`all` are snapshotted once at the top of this call, so
         * two arrows landing on the same face in the same tick would both
         * find it here and both fire `onHit` — the second scoring against a
         * butt the first already killed. Claiming the tag the instant a hit
         * resolves (rather than waiting for world.ts's once-a-frame refresh,
         * which runs before this loop, not during it) makes a second arrow
         * this same tick see the face as already spoken for.
         */
        const alreadyClaimed = obj.userData.arrowTarget === false;
        if (obj.userData.arrowTarget) obj.userData.arrowTarget = false;
        a.mesh.position.copy(hit.point);
        a.stuck = dt;
        if (!alreadyClaimed) onHit(a, obj, hit.point.clone());
        continue;
      }
    }

    if (!a.mine && player && a.mesh.position.z > player.getWorldPosition(new T.Vector3()).z + 3) {
      // Gone past and behind: it missed, and saying so is what makes a near
      // miss feel like one.
      a.life = 0;
      onHit(a, scene);
      continue;
    }

    if (a.life <= 0) onHit(a, scene);
  }

  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    const done = a.stuck > 0 ? a.stuck >= STUCK_FADE : a.life <= 0;
    if (done) {
      disposeArrow(scene, a.mesh);
      arrows.splice(i, 1);
    }
  }
}
