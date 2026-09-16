/**
 * Sherwood, built once.
 *
 * Everything here is primitive geometry generated in code: cones, cylinders,
 * jittered icosahedra. That is not a shortcut, it is the art style — the
 * low-poly games this is modelled on are boxes and cones with flat shading and
 * a warm sky, and none of it is sculpted. So there are no asset files to load,
 * nothing to fetch, and the whole wood is built in a few milliseconds.
 */
import * as T from "three";
import { LANES } from "./butts";

export interface Wood {
  root: T.Group;
  sun: T.DirectionalLight;
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * The wood, built once.
 *
 * Fog does the heavy lifting: it hides the far edge of the ground plane, so
 * the world reads as continuing rather than as a disc floating in a colour.
 */
export function buildWood(scene: T.Scene): Wood {
  const root = new T.Group();

  const dusk = new T.Color("#132a1f");
  scene.background = new T.Color("#1d3a2a");
  scene.fog = new T.Fog(dusk.getHex(), 40, 150);

  root.add(new T.AmbientLight(0x8fb39a, 1.5));
  const sun = new T.DirectionalLight(0xffe9b0, 2.1);
  sun.position.set(-30, 40, 20);
  root.add(sun);

  // Ground: one big plane, gently displaced so it is not a mirror.
  const g = new T.PlaneGeometry(400, 400, 40, 40);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, Math.sin(pos.getX(i) * 0.08) * 0.7 + Math.cos(pos.getY(i) * 0.06) * 0.6);
  }
  g.computeVertexNormals();
  const ground = new T.Mesh(
    g,
    new T.MeshLambertMaterial({ color: 0x2f5a3c, flatShading: true }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  for (const z of LANES) hedge(root, z);
  for (let i = 0; i < 90; i++) {
    tree(root, rand(-90, 90), rand(-150, -8));
  }
  for (let i = 0; i < 40; i++) {
    rock(root, rand(-70, 70), rand(-95, -6));
  }

  /*
   * The things that make it a range in Sherwood rather than a wood.
   *
   * A shooting range is a made place: someone put the butts there, stacked
   * the straw, hung the pennants and lit a fire. Without them it is just
   * trees with targets in, which is what the first pass looked like.
   */
  palisade(root, -58);
  for (let i = 0; i < 14; i++) bale(root, rand(-40, 40), rand(-46, -10));
  for (const x of [-24, -8, 8, 24]) pennant(root, x, -52);
  campfire(root, -16, 8);
  campfire(root, 19, 4);

  oak(root, -36, -22);
  oak(root, 34, -30);
  tower(root, -62, -132);

  scene.add(root);
  return { root, sun };
}

/**
 * Free every mesh's geometry and material under the wood's root.
 *
 * `page.tsx` builds a new `World` — and so a whole new wood, roughly 700
 * scenery geometries and materials — every round, and the old one used to
 * just be discarded: `buildWood`'s return value was never kept anywhere, so
 * nothing could ever free it, and `renderer.dispose()` frees the GPU context,
 * not the meshes that were drawn through it. `world.ts` keeps the `Wood`
 * handle this returns so `stop()` can call this and actually let a round's
 * scenery go.
 */
export function disposeWood(wood: Wood): void {
  wood.root.traverse((o) => {
    if (!(o instanceof T.Mesh)) return;
    o.geometry.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

/**
 * A great oak, the size the Major Oak actually is.
 *
 * The ordinary trees are cones on sticks and read as woodland. One tree that
 * dwarfs them, with a trunk you could hide behind and boughs that spread
 * rather than point, is the difference between a forest and *that* forest.
 */
function oak(root: T.Group, x: number, z: number) {
  const bark = new T.MeshLambertMaterial({ color: 0x4a3826, flatShading: true });
  const leaf = new T.MeshLambertMaterial({ color: 0x2c5233, flatShading: true });
  const trunk = new T.Mesh(new T.CylinderGeometry(1.6, 2.8, 11, 7), bark);
  trunk.position.set(x, 5.5, z);
  root.add(trunk);
  // Boughs out and up, each carrying its own mass of leaves.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rand(-0.3, 0.3);
    const len = rand(5, 8);
    const bough = new T.Mesh(new T.CylinderGeometry(0.35, 0.8, len, 5), bark);
    bough.position.set(x + Math.cos(a) * len * 0.35, 10 + rand(0, 2), z + Math.sin(a) * len * 0.35);
    bough.rotation.set(Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8);
    root.add(bough);
    const crown = new T.Mesh(new T.IcosahedronGeometry(rand(4, 5.6), 0), leaf);
    crown.position.set(x + Math.cos(a) * len * 0.8, 12.5 + rand(0, 2.5), z + Math.sin(a) * len * 0.8);
    root.add(crown);
  }
  const top = new T.Mesh(new T.IcosahedronGeometry(6, 0), leaf);
  top.position.set(x, 16, z);
  root.add(top);
}

/**
 * Nottingham, far enough off to be a shape in the fog.
 *
 * It never gets close enough to need detail, and it gives the eye somewhere
 * to land past the palisade — a horizon with something on it, rather than a
 * colour that stops.
 */
function tower(root: T.Group, x: number, z: number) {
  const stone = new T.MeshLambertMaterial({ color: 0x2a3b34, flatShading: true });
  for (const [dx, h, r] of [
    [0, 34, 5],
    [-11, 24, 4],
    [12, 27, 4.5],
  ] as const) {
    const keep = new T.Mesh(new T.CylinderGeometry(r, r * 1.15, h, 8), stone);
    keep.position.set(x + dx, h / 2, z);
    root.add(keep);
    const cap = new T.Mesh(new T.ConeGeometry(r * 1.2, r * 1.4, 8), stone);
    cap.position.set(x + dx, h + r * 0.7, z);
    root.add(cap);
  }
  const wall = new T.Mesh(new T.BoxGeometry(46, 14, 4), stone);
  wall.position.set(x, 7, z + 3);
  root.add(wall);
}

/** A run of sharpened stakes along the far edge, closing the range in. */
function palisade(root: T.Group, z: number) {
  const mat = new T.MeshLambertMaterial({ color: 0x4a3a28, flatShading: true });
  for (let x = -70; x < 70; x += 1.9) {
    const h = rand(5.5, 7);
    const post = new T.Mesh(new T.CylinderGeometry(0.45, 0.55, h, 5), mat);
    post.position.set(x, h / 2, z + rand(-0.3, 0.3));
    root.add(post);
    const tip = new T.Mesh(new T.ConeGeometry(0.5, 1.1, 5), mat);
    tip.position.set(post.position.x, h + 0.5, post.position.z);
    root.add(tip);
  }
}

/** Straw bales, the thing a real butt is actually made of. */
function bale(root: T.Group, x: number, z: number) {
  const m = new T.Mesh(
    new T.BoxGeometry(rand(2.4, 3.4), rand(1.4, 2), rand(1.6, 2.2)),
    new T.MeshLambertMaterial({ color: 0xb8a06a, flatShading: true }),
  );
  m.position.set(x, 0.9, z);
  m.rotation.y = rand(-0.4, 0.4);
  root.add(m);
}

/** A pennant on a pole. Lincoln green, because of course. */
function pennant(root: T.Group, x: number, z: number) {
  const pole = new T.Mesh(
    new T.CylinderGeometry(0.14, 0.16, 11, 5),
    new T.MeshLambertMaterial({ color: 0x5a4630, flatShading: true }),
  );
  pole.position.set(x, 5.5, z);
  root.add(pole);
  const flag = new T.Mesh(
    new T.PlaneGeometry(3.2, 1.5),
    new T.MeshLambertMaterial({ color: 0x2e7d4f, side: T.DoubleSide, flatShading: true }),
  );
  flag.position.set(x + 1.7, 9.6, z);
  root.add(flag);
}

/** A camp fire, for the warm light a green wood otherwise lacks. */
function campfire(root: T.Group, x: number, z: number) {
  const ring = new T.Mesh(
    new T.TorusGeometry(1.5, 0.32, 5, 9),
    new T.MeshLambertMaterial({ color: 0x4a4f46, flatShading: true }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.25, z);
  root.add(ring);
  const flame = new T.Mesh(
    new T.ConeGeometry(0.9, 2.2, 5),
    new T.MeshBasicMaterial({ color: 0xffa338 }),
  );
  flame.position.set(x, 1.2, z);
  root.add(flame);
  // A point light rather than a decal, so it actually reaches the ground.
  const l = new T.PointLight(0xff9a3c, 60, 26, 2);
  l.position.set(x, 2.2, z);
  root.add(l);
}

/** A run of low bushes the butts rise from behind. */
function hedge(root: T.Group, z: number) {
  const mat = new T.MeshLambertMaterial({ color: 0x1e4a30, flatShading: true });
  for (let x = -80; x < 80; x += rand(3.2, 5.2)) {
    const r = rand(1.4, 2.2);
    const m = new T.Mesh(new T.IcosahedronGeometry(r, 0), mat);
    m.position.set(x, r * 0.55, z + rand(-0.8, 0.8));
    m.scale.y = 0.75;
    m.rotation.y = rand(0, Math.PI);
    root.add(m);
  }
}

function tree(root: T.Group, x: number, z: number) {
  const h = rand(9, 17);
  const trunk = new T.Mesh(
    new T.CylinderGeometry(rand(0.3, 0.55), rand(0.5, 0.8), h, 6),
    new T.MeshLambertMaterial({ color: 0x3b2b1d, flatShading: true }),
  );
  trunk.position.set(x, h / 2, z);
  root.add(trunk);
  // Two or three cones stacked, which is the whole vocabulary of a low-poly
  // conifer and reads correctly from any angle.
  const tiers = Math.random() < 0.5 ? 2 : 3;
  const leaf = new T.MeshLambertMaterial({
    color: new T.Color().setHSL(0.33, rand(0.35, 0.5), rand(0.16, 0.26)),
    flatShading: true,
  });
  for (let i = 0; i < tiers; i++) {
    const r = rand(3.2, 4.6) * (1 - i * 0.22);
    const ch = rand(4.5, 6.5);
    const cone = new T.Mesh(new T.ConeGeometry(r, ch, 7), leaf);
    cone.position.set(x, h * 0.62 + i * ch * 0.52, z);
    root.add(cone);
  }
}

function rock(root: T.Group, x: number, z: number) {
  const r = rand(0.8, 2.4);
  const m = new T.Mesh(
    new T.IcosahedronGeometry(r, 0),
    new T.MeshLambertMaterial({ color: 0x4a4f46, flatShading: true }),
  );
  m.position.set(x, r * 0.5, z);
  m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
  root.add(m);
}
