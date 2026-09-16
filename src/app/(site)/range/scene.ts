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
import { rand } from "./rand";

export interface Wood {
  root: T.Group;
  sun: T.DirectionalLight;
}

/** The sun's elevation above the horizon, in degrees. Low: this is golden
    hour, not noon, and everything about the shadows and the sky reads off
    this one number.

    Was 8: at 8° the N·L term on flat ground is sin(8°) ≈ 0.139, so the
    ground receives almost nothing no matter how bright the sun is or how
    much ambient is stacked on top — ambient lifts lit and shadowed ground
    by the same flat amount, so it cannot restore the contrast a low N·L
    erases. 13° puts sin(13°) ≈ 0.225 on the ground — lighting it through
    the sun rather than through the fill. */
export const SUN_ANGLE_DEG = 13;

/**
 * The wood, built once.
 *
 * Fog does the heavy lifting: it hides the far edge of the ground plane, so
 * the world reads as continuing rather than as a disc floating in a colour.
 * At golden hour the fog itself is warm — the haze a low sun throws across
 * a wood — rather than the dusk-blue it was.
 */
export function buildWood(scene: T.Scene): Wood {
  const root = new T.Group();

  // 35–180: close enough that the near rank (the firing line, the first
  // hedge) stays clean, far enough out that the far rank picks up real
  // haze rather than the fog only ever reaching the castle beyond it.
  scene.fog = new T.Fog(0xd8a367, 35, 180);
  root.add(sky());

  // Cool and dim: this is what makes a low sun read as low. A bright, warm
  // ambient would fill in every shadow and flatten the light right back out
  // — the shadowed side of a trunk should read as sky-lit blue, not as the
  // same green the sunlit side is.
  //
  // Ambient is the wrong lever for "the ground is too dark": it adds the
  // same flat term to lit and shadowed ground alike, so raising it lifts
  // the floor without restoring any contrast between them — brighter and
  // flatter, the opposite of what shadows need. The real fix for a dim
  // ground is the sun's own angle (see SUN_ANGLE_DEG); this stays at the
  // brief's own figure.
  root.add(new T.AmbientLight(0x6a7f9a, 0.65));

  const sun = new T.DirectionalLight(0xffd9a0, 2.4);
  const elevation = (SUN_ANGLE_DEG * Math.PI) / 180;
  // Low, and to the right: +x is screen-right for the camera's default
  // orientation (looking down -z), so this is a low sun over the shooter's
  // right shoulder, not overhead.
  sun.position.set(Math.cos(elevation) * 160, Math.sin(elevation) * 160, 55);
  sun.target.position.set(0, 4, -55);
  root.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0015;
  const shadowCam = sun.shadow.camera;
  // Fitted to the range — the firing line to just past the palisade, and
  // the width the butts and the near trees actually occupy — rather than
  // the whole 400-unit ground plane. A shadow map has a budget, and most of
  // that plane is fog before it is anything worth a hard shadow.
  shadowCam.left = -110;
  shadowCam.right = 110;
  shadowCam.top = 90;
  shadowCam.bottom = -50;
  shadowCam.near = 10;
  shadowCam.far = 420;
  shadowCam.updateProjectionMatrix();
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
  ground.receiveShadow = true;
  root.add(ground);

  motes(root);

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
 *
 * The pollen (a `T.Points`, not a `T.Mesh`) has its own geometry and material
 * the same way — `instanceof T.Mesh` alone would walk straight past it and
 * leak its buffer every round.
 */
export function disposeWood(wood: Wood): void {
  wood.root.traverse((o) => {
    if (!(o instanceof T.Mesh) && !(o instanceof T.Points)) return;
    o.geometry.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

/**
 * The sky: a deep blue overhead falling through a warm mid-tone to a hot
 * orange-gold band at the horizon.
 *
 * A flat background colour cannot give the horizon a band of colour that is
 * hotter than the sky above it — that needs a gradient, so this is a large
 * sphere seen from inside (`BackSide`) with a tiny shader doing the mixing
 * per-pixel rather than a texture. It ignores fog (`fog: false`) and scene
 * lighting entirely: it is the backdrop the fog and the sun's haze sit in
 * front of, not an object the sun lights.
 */
function sky(): T.Mesh {
  const geo = new T.SphereGeometry(380, 24, 16);
  const mat = new T.ShaderMaterial({
    uniforms: {
      top: { value: new T.Color(0x16243a) },
      mid: { value: new T.Color(0x6b4a3a) },
      hot: { value: new T.Color(0xe08a3c) },
      horizon: { value: new T.Color(0xf4b35a) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 top;
      uniform vec3 mid;
      uniform vec3 hot;
      uniform vec3 horizon;
      void main() {
        // h is sin(elevation): the old stops (mid-to-top starting at
        // h=0.5, i.e. 30 degrees up) put the blue above where the camera's
        // 72-degree FOV and pitch clamp ever look — roughly 36 degrees at
        // rest, 52 at full up-look — so it never appeared in play and the
        // orange band filled the whole dome instead. Compressed so the top
        // is fully reached by h=0.6 (about 37 degrees), inside that band.
        float h = vDir.y;
        vec3 col;
        if (h > 0.25) {
          col = mix(mid, top, smoothstep(0.25, 0.6, h));
        } else if (h > 0.05) {
          col = mix(hot, mid, smoothstep(0.05, 0.25, h));
        } else {
          col = mix(horizon, hot, smoothstep(-0.05, 0.05, h));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: T.BackSide,
    fog: false,
    depthWrite: false,
  });
  const mesh = new T.Mesh(geo, mat);
  // Drawn first and never depth-tested against, so it cannot fight the fog
  // or the scenery for which one is "in front".
  mesh.renderOrder = -1;
  return mesh;
}

/** The per-mote state `stepWood` reads and writes each simulation tick,
    stashed on the `Points` object's own `userData` under this key so
    `stepWood` can find it by traversal without `Wood`'s own shape (just
    `root` and `sun`) having to carry it. */
const MOTES_KEY = "motes";

interface MotesState {
  posAttr: T.BufferAttribute;
  baseY: Float32Array;
  speed: Float32Array;
  span: number;
  floor: number;
  t: number;
}

/**
 * Pollen drifting through the sun's beam.
 *
 * One `Points` cloud, one buffer: the positions are written back into the
 * same `Float32Array` in place by `stepWood`, driven by the game's own
 * simulation `dt` — not wall-clock time, which would keep drifting through
 * a pause (attract mode, most obviously) since nothing would be stepping
 * the rest of the world either.
 */
function motes(root: T.Group) {
  const COUNT = 260;
  const SPAN = 12; // the height of the slab the pollen loops within
  const FLOOR = 1.5;
  const positions = new Float32Array(COUNT * 3);
  const baseY = new Float32Array(COUNT);
  const speed = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = rand(-55, 55);
    positions[i * 3 + 1] = rand(FLOOR, FLOOR + SPAN);
    positions[i * 3 + 2] = rand(-60, 15);
    baseY[i] = positions[i * 3 + 1];
    speed[i] = rand(0.2, 0.55);
  }
  const geo = new T.BufferGeometry();
  const posAttr = new T.BufferAttribute(positions, 3);
  geo.setAttribute("position", posAttr);
  const mat = new T.PointsMaterial({
    color: 0xffdca0,
    size: 0.14,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new T.Points(geo, mat);
  // The slab sits above the whole range, not just whatever the frustum
  // currently contains, so it must never be culled against a stale box.
  points.frustumCulled = false;
  const state: MotesState = { posAttr, baseY, speed, span: SPAN, floor: FLOOR, t: 0 };
  points.userData[MOTES_KEY] = state;
  root.add(points);
}

/**
 * Advance whatever in `wood` has per-frame state — currently just the
 * pollen — by one simulation tick. `world.ts`'s `step(dt)` calls this
 * alongside everything else it advances, so the motes freeze exactly when
 * the round does (paused, game-over, or simply not yet started) instead of
 * drifting on regardless.
 */
export function stepWood(wood: Wood, dt: number): void {
  wood.root.traverse((o) => {
    const state = o.userData[MOTES_KEY] as MotesState | undefined;
    if (!state) return;
    state.t += dt;
    const { posAttr, baseY, speed, span, floor } = state;
    for (let i = 0; i < baseY.length; i++) {
      const y = floor + (((baseY[i] - floor + state.t * speed[i]) % span) + span) % span;
      posAttr.setY(i, y);
    }
    posAttr.needsUpdate = true;
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
  trunk.castShadow = true;
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
    post.castShadow = true;
    root.add(post);
    const tip = new T.Mesh(new T.ConeGeometry(0.5, 1.1, 5), mat);
    tip.position.set(post.position.x, h + 0.5, post.position.z);
    tip.castShadow = true;
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
    m.receiveShadow = true;
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
  trunk.castShadow = true;
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
