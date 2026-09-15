import * as T from "three";
import type { Butt } from "./butts";
import { rand } from "./scene";

export interface Arrow {
  mesh: T.Mesh;
  vel: T.Vector3;
  life: number;
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
  return { mesh, vel, life: 4 };
}
