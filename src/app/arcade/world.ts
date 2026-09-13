/**
 * Sherwood in three dimensions.
 *
 * The flat version read as what it was: shapes on a plane. Depth is the whole
 * difference — a target behind a trunk is genuinely behind it, the scope
 * narrows the field of view rather than drawing a smaller circle, and an arrow
 * coming at you grows.
 *
 * Everything here is primitive geometry generated in code: cones, cylinders,
 * jittered icosahedra. That is not a shortcut, it is the art style — the
 * low-poly games this is modelled on are boxes and cones with flat shading and
 * a warm sky, and none of it is sculpted. So there are no asset files to load,
 * nothing to fetch, and the whole wood is built in a few milliseconds.
 *
 * Three.js only lives on this route, so the terminal's bundle never sees it.
 */
import * as T from "three";

export interface Stock {
  symbol: string;
  changePct: number;
}

export interface Snapshot {
  points: number;
  /** 0-100. A bar reads as a state you are in; three dots read as a counter. */
  health: number;
  lives: number;
  hits: number;
  shots: number;
  combo: number;
  msLeft: number;
  over: boolean;
}

export const ROUND_MS = 60_000;
const START_LIVES = 3;
/** Field of view wide, and narrowed when the scope is up. */
const FOV_WIDE = 72;
const FOV_SCOPE = 26;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Butt {
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
}

interface Arrow {
  mesh: T.Mesh;
  vel: T.Vector3;
  life: number;
}

/** Where the three rows of cover sit, in world units away from the camera. */
const LANES = [-14, -28, -44];
/** How near an arrow has to pass to count. Generous: this is an arcade. */
const HIT_RADIUS = 2.6;

export class World {
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera: T.PerspectiveCamera;
  private raycaster = new T.Raycaster();
  private butts: Butt[] = [];
  private arrows: Arrow[] = [];
  private raf = 0;
  private running = false;
  private last = 0;
  private spawnIn = 0.5;
  /** Head turn, in radians. Clamped so you cannot spin round to the trees behind. */
  private yaw = 0;
  private pitch = 0;

  points = 0;
  health = 100;
  lives = START_LIVES;
  hits = 0;
  shots = 0;
  combo = 0;
  msLeft = ROUND_MS;
  over = false;
  /** Read it, but set it through setScoped so the view can follow. */
  scoped = false;
  /** Seconds of red flash left after taking an arrow. */
  hurt = 0;
  /** The bow in your hands, and how far through nocking the next arrow it is. */
  private bow: T.Group | null = null;
  private nock: T.Mesh | null = null;
  private drawn = 1;
  /**
   * Where on the screen the shot goes, in clip space.
   *
   * Centre under pointer lock, because the view turns and the reticle does
   * not. The cursor's own position when the lock was refused — which is the
   * bug this exists to fix: the shot used to go down the middle of the screen
   * whatever the crosshair was sitting on, so every carefully aimed shot
   * missed and the game looked like it was ignoring the mouse.
   */
  private aim = new T.Vector2(0, 0);
  private cursor = new T.Vector2(0.5, 0.5);
  /** True until something tells us the browser gave us a locked pointer. */
  pointerAiming = true;
  sfx: { loose(): void; thunk(): void; miss(): void; hurt(): void; chime(n: number): void; horn(): void } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private stocks: Stock[],
    private onChange: (s: Snapshot) => void,
  ) {
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new T.PerspectiveCamera(FOV_WIDE, 1, 0.1, 400);
    // Back from the first hedge, so there is ground between you and the
    // nearest butt and the range reads as a range rather than a wall.
    this.camera.position.set(0, 3.6, 20);
    this.buildWorld();
    this.resize();
  }

  private snapshot(): Snapshot {
    return {
      points: this.points,
      health: this.health,
      lives: this.lives,
      hits: this.hits,
      shots: this.shots,
      combo: this.combo,
      msLeft: this.msLeft,
      over: this.over,
    };
  }

  /**
   * The wood, built once.
   *
   * Fog does the heavy lifting: it hides the far edge of the ground plane, so
   * the world reads as continuing rather than as a disc floating in a colour.
   */
  private buildWorld() {
    const dusk = new T.Color("#132a1f");
    this.scene.background = new T.Color("#1d3a2a");
    this.scene.fog = new T.Fog(dusk.getHex(), 40, 150);

    this.scene.add(new T.AmbientLight(0x8fb39a, 1.5));
    const sun = new T.DirectionalLight(0xffe9b0, 2.1);
    sun.position.set(-30, 40, 20);
    this.scene.add(sun);

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
    this.scene.add(ground);

    for (const z of LANES) this.hedge(z);
    for (let i = 0; i < 90; i++) {
      this.tree(rand(-90, 90), rand(-150, -8));
    }
    for (let i = 0; i < 40; i++) {
      this.rock(rand(-70, 70), rand(-95, -6));
    }

    /*
     * The things that make it a range in Sherwood rather than a wood.
     *
     * A shooting range is a made place: someone put the butts there, stacked
     * the straw, hung the pennants and lit a fire. Without them it is just
     * trees with targets in, which is what the first pass looked like.
     */
    this.palisade(-58);
    for (let i = 0; i < 14; i++) this.bale(rand(-40, 40), rand(-46, -10));
    for (const x of [-24, -8, 8, 24]) this.pennant(x, -52);
    this.campfire(-16, 8);
    this.campfire(19, 4);

    this.oak(-36, -22);
    this.oak(34, -30);
    this.tower(-62, -132);
    this.buildBow();
  }

  /**
   * A great oak, the size the Major Oak actually is.
   *
   * The ordinary trees are cones on sticks and read as woodland. One tree that
   * dwarfs them, with a trunk you could hide behind and boughs that spread
   * rather than point, is the difference between a forest and *that* forest.
   */
  private oak(x: number, z: number) {
    const bark = new T.MeshLambertMaterial({ color: 0x4a3826, flatShading: true });
    const leaf = new T.MeshLambertMaterial({ color: 0x2c5233, flatShading: true });
    const trunk = new T.Mesh(new T.CylinderGeometry(1.6, 2.8, 11, 7), bark);
    trunk.position.set(x, 5.5, z);
    this.scene.add(trunk);
    // Boughs out and up, each carrying its own mass of leaves.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rand(-0.3, 0.3);
      const len = rand(5, 8);
      const bough = new T.Mesh(new T.CylinderGeometry(0.35, 0.8, len, 5), bark);
      bough.position.set(x + Math.cos(a) * len * 0.35, 10 + rand(0, 2), z + Math.sin(a) * len * 0.35);
      bough.rotation.set(Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8);
      this.scene.add(bough);
      const crown = new T.Mesh(new T.IcosahedronGeometry(rand(4, 5.6), 0), leaf);
      crown.position.set(x + Math.cos(a) * len * 0.8, 12.5 + rand(0, 2.5), z + Math.sin(a) * len * 0.8);
      this.scene.add(crown);
    }
    const top = new T.Mesh(new T.IcosahedronGeometry(6, 0), leaf);
    top.position.set(x, 16, z);
    this.scene.add(top);
  }

  /**
   * Nottingham, far enough off to be a shape in the fog.
   *
   * It never gets close enough to need detail, and it gives the eye somewhere
   * to land past the palisade — a horizon with something on it, rather than a
   * colour that stops.
   */
  private tower(x: number, z: number) {
    const stone = new T.MeshLambertMaterial({ color: 0x2a3b34, flatShading: true });
    for (const [dx, h, r] of [
      [0, 34, 5],
      [-11, 24, 4],
      [12, 27, 4.5],
    ] as const) {
      const keep = new T.Mesh(new T.CylinderGeometry(r, r * 1.15, h, 8), stone);
      keep.position.set(x + dx, h / 2, z);
      this.scene.add(keep);
      const cap = new T.Mesh(new T.ConeGeometry(r * 1.2, r * 1.4, 8), stone);
      cap.position.set(x + dx, h + r * 0.7, z);
      this.scene.add(cap);
    }
    const wall = new T.Mesh(new T.BoxGeometry(46, 14, 4), stone);
    wall.position.set(x, 7, z + 3);
    this.scene.add(wall);
  }

  /**
   * The longbow, in your hands.
   *
   * Nothing else says which century this is as immediately as seeing the bow
   * you are shooting. It hangs off the camera rather than the scene, so it
   * stays put in the corner of the view however you turn — the standard way a
   * first-person weapon is held, and far cheaper than animating an arm.
   *
   * Children of a camera only render if the camera is itself in the scene, so
   * it is added here.
   */
  private buildBow() {
    const wood = new T.MeshLambertMaterial({ color: 0x6b4a2a, flatShading: true });
    const g = new T.Group();

    // A yew stave: most of a circle is too round, a shallow arc is a longbow.
    const stave = new T.Mesh(new T.TorusGeometry(0.52, 0.028, 5, 20, Math.PI * 1.1), wood);
    stave.rotation.z = -Math.PI * 0.05;
    g.add(stave);
    const grip = new T.Mesh(new T.CylinderGeometry(0.045, 0.045, 0.22, 6), wood);
    grip.position.set(-0.5, 0, 0);
    grip.rotation.z = Math.PI / 2;
    g.add(grip);
    const string = new T.Mesh(
      new T.CylinderGeometry(0.006, 0.006, 0.98, 3),
      new T.MeshBasicMaterial({ color: 0xd9d2bc }),
    );
    string.position.set(-0.36, 0, 0);
    g.add(string);

    const shaft = new T.Mesh(
      new T.CylinderGeometry(0.018, 0.018, 0.95, 4),
      new T.MeshLambertMaterial({ color: 0xe8d9a8, flatShading: true }),
    );
    shaft.geometry.rotateZ(Math.PI / 2);
    shaft.position.set(-0.1, 0.02, 0);
    g.add(shaft);
    this.nock = shaft;

    /*
     * Where a bow actually is when you are holding it.
     *
     * The first version sat small and far off in the corner, which read as a
     * prop lying in the scene rather than something in your hands. A held
     * longbow is close enough to be out of focus, big enough to run off the
     * bottom of the view, and canted rather than upright — you look past the
     * stave, not over it.
     */
    g.scale.setScalar(1.9);
    g.position.set(0.5, -0.72, -1.05);
    g.rotation.set(0.12, -0.34, -0.22);
    this.bow = g;
    this.camera.add(g);
    this.scene.add(this.camera);
  }

  /** A run of sharpened stakes along the far edge, closing the range in. */
  private palisade(z: number) {
    const mat = new T.MeshLambertMaterial({ color: 0x4a3a28, flatShading: true });
    for (let x = -70; x < 70; x += 1.9) {
      const h = rand(5.5, 7);
      const post = new T.Mesh(new T.CylinderGeometry(0.45, 0.55, h, 5), mat);
      post.position.set(x, h / 2, z + rand(-0.3, 0.3));
      this.scene.add(post);
      const tip = new T.Mesh(new T.ConeGeometry(0.5, 1.1, 5), mat);
      tip.position.set(post.position.x, h + 0.5, post.position.z);
      this.scene.add(tip);
    }
  }

  /** Straw bales, the thing a real butt is actually made of. */
  private bale(x: number, z: number) {
    const m = new T.Mesh(
      new T.BoxGeometry(rand(2.4, 3.4), rand(1.4, 2), rand(1.6, 2.2)),
      new T.MeshLambertMaterial({ color: 0xb8a06a, flatShading: true }),
    );
    m.position.set(x, 0.9, z);
    m.rotation.y = rand(-0.4, 0.4);
    this.scene.add(m);
  }

  /** A pennant on a pole. Lincoln green, because of course. */
  private pennant(x: number, z: number) {
    const pole = new T.Mesh(
      new T.CylinderGeometry(0.14, 0.16, 11, 5),
      new T.MeshLambertMaterial({ color: 0x5a4630, flatShading: true }),
    );
    pole.position.set(x, 5.5, z);
    this.scene.add(pole);
    const flag = new T.Mesh(
      new T.PlaneGeometry(3.2, 1.5),
      new T.MeshLambertMaterial({ color: 0x2e7d4f, side: T.DoubleSide, flatShading: true }),
    );
    flag.position.set(x + 1.7, 9.6, z);
    this.scene.add(flag);
  }

  /** A camp fire, for the warm light a green wood otherwise lacks. */
  private campfire(x: number, z: number) {
    const ring = new T.Mesh(
      new T.TorusGeometry(1.5, 0.32, 5, 9),
      new T.MeshLambertMaterial({ color: 0x4a4f46, flatShading: true }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.25, z);
    this.scene.add(ring);
    const flame = new T.Mesh(
      new T.ConeGeometry(0.9, 2.2, 5),
      new T.MeshBasicMaterial({ color: 0xffa338 }),
    );
    flame.position.set(x, 1.2, z);
    this.scene.add(flame);
    // A point light rather than a decal, so it actually reaches the ground.
    const l = new T.PointLight(0xff9a3c, 60, 26, 2);
    l.position.set(x, 2.2, z);
    this.scene.add(l);
  }

  /** A run of low bushes the butts rise from behind. */
  private hedge(z: number) {
    const mat = new T.MeshLambertMaterial({ color: 0x1e4a30, flatShading: true });
    for (let x = -80; x < 80; x += rand(3.2, 5.2)) {
      const r = rand(1.6, 2.6);
      const m = new T.Mesh(new T.IcosahedronGeometry(r, 0), mat);
      m.position.set(x, r * 0.55, z + rand(-0.8, 0.8));
      m.scale.y = 0.75;
      m.rotation.y = rand(0, Math.PI);
      this.scene.add(m);
    }
  }

  private tree(x: number, z: number) {
    const h = rand(9, 17);
    const trunk = new T.Mesh(
      new T.CylinderGeometry(rand(0.3, 0.55), rand(0.5, 0.8), h, 6),
      new T.MeshLambertMaterial({ color: 0x3b2b1d, flatShading: true }),
    );
    trunk.position.set(x, h / 2, z);
    this.scene.add(trunk);
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
      this.scene.add(cone);
    }
  }

  private rock(x: number, z: number) {
    const r = rand(0.8, 2.4);
    const m = new T.Mesh(
      new T.IcosahedronGeometry(r, 0),
      new T.MeshLambertMaterial({ color: 0x4a4f46, flatShading: true }),
    );
    m.position.set(x, r * 0.5, z);
    m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    this.scene.add(m);
  }

  /**
   * The ticker, drawn to a texture.
   *
   * A canvas texture rather than a font loader: it needs one short string per
   * target, and shipping a typeface to render six characters would cost more
   * than the rest of the wood put together.
   */
  private label(text: string, colour: string): T.Texture {
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 128;
    const c = cv.getContext("2d")!;
    c.fillStyle = "#efe4c8";
    c.fillRect(0, 0, 256, 128);
    c.strokeStyle = colour;
    c.lineWidth = 10;
    c.strokeRect(5, 5, 246, 118);
    c.fillStyle = "#12181f";
    c.font = "bold 54px ui-monospace, monospace";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text.slice(0, 6), 128, 68);
    const tex = new T.CanvasTexture(cv);
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }

  private spawn() {
    if (!this.stocks.length) return;
    const stock = this.stocks[Math.floor(Math.random() * this.stocks.length)];
    const hostile = stock.changePct < 0;
    const lane = Math.floor(Math.random() * LANES.length);
    const z = LANES[lane];
    const group = new T.Group();

    const ringColour = hostile ? "#ff5d5d" : "#7ae089";
    // The butt: a straw roundel on a post, facing the shooter.
    const face = new T.Mesh(
      new T.CircleGeometry(2.6, 20),
      new T.MeshLambertMaterial({
        map: this.label(stock.symbol, ringColour),
        // Both sides, so a butt that spawns turned slightly away is still a
        // target rather than an invisible one.
        side: T.DoubleSide,
      }),
    );
    face.position.y = 3.4;
    group.add(face);

    const rim = new T.Mesh(
      new T.TorusGeometry(2.65, 0.2, 6, 22),
      new T.MeshLambertMaterial({ color: new T.Color(ringColour), flatShading: true }),
    );
    rim.position.y = 3.4;
    group.add(rim);

    const post = new T.Mesh(
      new T.CylinderGeometry(0.16, 0.2, 3.6, 5),
      new T.MeshLambertMaterial({ color: 0x4a3a28, flatShading: true }),
    );
    post.position.y = 1.6;
    group.add(post);

    const x = rand(-30, 30);
    group.position.set(x, -4.5, z);
    this.scene.add(group);

    this.butts.push({
      group,
      stock,
      hostile,
      face,
      lane,
      x,
      vx: (Math.random() < 0.5 ? 1 : -1) * rand(1.6, 4.2),
      out: 0,
      rising: true,
      dwell: rand(0.4, 1.1),
      cooldown: rand(0.6, 1.3),
      dead: 0,
    });
  }

  /**
   * Point the view at a spot on the canvas, 0..1 in each axis.
   *
   * The unlocked fallback. Mapped across the same clamped range that `look`
   * moves through, so both ways of aiming can reach exactly the same places.
   */
  aimAt(fx: number, fy: number) {
    const x = Math.max(0, Math.min(1, fx));
    const y = Math.max(0, Math.min(1, fy));
    this.aim.set(x * 2 - 1, -(y * 2 - 1));
    this.cursor.set(x, y);
  }

  /**
   * Raise or lower the scope.
   *
   * Unlocked, the view is fixed and the cursor does the aiming — so zooming
   * in on the middle of the screen would zoom past whatever you were actually
   * pointing at. Raising the scope therefore swings the view to the cursor
   * once, and from then on the scope is the middle of the screen like it is
   * in every other shooter. Lowering it puts the view back.
   */
  setScoped(on: boolean) {
    if (this.scoped === on) return;
    this.scoped = on;
    if (this.pointerAiming) {
      if (on) {
        this.aimFromCursor();
        this.aim.set(0, 0);
      } else {
        this.yaw = 0;
        this.pitch = 0;
        this.aimAt(this.cursor.x, this.cursor.y);
      }
    }
  }

  /** Turn the head to wherever the cursor is pointing, once. */
  private aimFromCursor() {
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(
      new T.Vector2(this.cursor.x * 2 - 1, -(this.cursor.y * 2 - 1)),
      this.camera,
    );
    const d = this.raycaster.ray.direction;
    this.yaw = Math.max(-0.85, Math.min(0.85, Math.atan2(-d.x, -d.z)));
    this.pitch = Math.max(-0.32, Math.min(0.28, Math.asin(Math.max(-1, Math.min(1, d.y)))));
  }

  /** Look. Yaw and pitch are clamped so the range stays in front of you. */
  look(dx: number, dy: number) {
    this.pointerAiming = false;
    this.aim.set(0, 0);
    this.yaw = Math.max(-0.85, Math.min(0.85, this.yaw - dx * (this.scoped ? 0.0009 : 0.0022)));
    this.pitch = Math.max(-0.32, Math.min(0.28, this.pitch - dy * (this.scoped ? 0.0009 : 0.0022)));
  }

  private step(dt: number) {
    if (this.over) return;
    if (this.hurt > 0) this.hurt = Math.max(0, this.hurt - dt);

    /*
     * Nocking the next arrow.
     *
     * `drawn` runs 0 → 1 after each shot. The bow kicks back and the arrow is
     * gone at the start of it and back on the string by the end, which is the
     * only thing telling you the shot registered when it misses everything.
     */
    if (this.drawn < 1) this.drawn = Math.min(1, this.drawn + dt * 2.4);
    if (this.bow) {
      this.bow.visible = !this.scoped;
      const kick = (1 - this.drawn) * (1 - this.drawn);
      this.bow.position.set(0.5 + kick * 0.1, -0.72 - kick * 0.05, -1.05 + kick * 0.14);
      if (this.nock) this.nock.visible = this.drawn > 0.55;
    }
    this.msLeft -= dt * 1000;
    if (this.msLeft <= 0 || this.lives <= 0) {
      this.msLeft = Math.max(0, this.msLeft);
      this.over = true;
      this.sfx?.horn();
      this.onChange(this.snapshot());
      return;
    }

    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      this.spawn();
      const progress = 1 - this.msLeft / ROUND_MS;
      this.spawnIn = rand(0.55, 1.5) * (1 - progress * 0.5);
    }

    for (const b of this.butts) {
      if (b.dead > 0) {
        b.dead -= dt;
        b.group.position.y -= dt * 9;
        b.group.rotation.z += dt * 5;
        continue;
      }
      b.x += b.vx * dt;
      if (b.x < -34 || b.x > 34) b.vx *= -1;

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
      b.group.position.set(b.x, -4.5 + b.out * 4.5, LANES[b.lane]);

      if (b.hostile && b.out > 0.6) {
        b.cooldown -= dt;
        if (b.cooldown <= 0) {
          b.cooldown = rand(1.1, 2.0);
          this.loose(b);
        }
      }
    }
    /*
     * A struck butt falls for its death timer and is then taken out of the
     * scene. Kept as one pass rather than two overlapping filters, which is
     * what this was and which left some of them in the world for ever.
     */
    this.butts = this.butts.filter((b) => {
      if (b.dead >= 0) return true;
      this.scene.remove(b.group);
      b.face.geometry.dispose();
      return false;
    });
    // A butt that has fully ducked has done its job and can go.
    this.butts = this.butts.filter((b) => {
      if (b.dead > 0 || b.rising || b.out > 0.01) return true;
      this.scene.remove(b.group);
      return false;
    });

    for (const a of this.arrows) {
      const before = a.mesh.position.clone();
      a.mesh.position.addScaledVector(a.vel, dt);
      a.mesh.lookAt(a.mesh.position.clone().add(a.vel));
      a.life -= dt;

      /*
       * Closest approach along the step, not the distance at the end of it.
       *
       * An arrow moves half a metre a frame near the end of its flight, so
       * testing only where it finished lets it tunnel straight past your head
       * between two frames and count as a miss. That is why nothing was ever
       * hitting: the shots were arriving, they were just never measured at
       * the moment they were close.
       */
      const seg = a.mesh.position.clone().sub(before);
      const toEye = this.camera.position.clone().sub(before);
      const len2 = seg.lengthSq() || 1;
      const t = Math.max(0, Math.min(1, toEye.dot(seg) / len2));
      const near = before.clone().addScaledVector(seg, t).distanceTo(this.camera.position);

      if (near < HIT_RADIUS) {
        a.life = 0;
        this.health = Math.max(0, this.health - 34);
        this.combo = 0;
        this.points = Math.max(0, this.points - 250);
        this.hurt = 0.5;
        this.sfx?.hurt();
        if (this.health <= 0) {
          this.lives = 0;
        }
        this.onChange(this.snapshot());
      } else if (a.mesh.position.z > this.camera.position.z + 3) {
        // Gone past and behind: it missed, and saying so is what makes a near
        // miss feel like one.
        a.life = 0;
        this.sfx?.miss();
      }
    }
    this.arrows = this.arrows.filter((a) => {
      if (a.life > 0) return true;
      this.scene.remove(a.mesh);
      return false;
    });
  }

  private loose(b: Butt) {
    const from = b.group.position.clone().add(new T.Vector3(0, 3.4, 0));
    const to = this.camera.position.clone();
    const vel = to.sub(from).normalize().multiplyScalar(rand(34, 42));
    const mesh = new T.Mesh(
      new T.CylinderGeometry(0.06, 0.06, 1.6, 4),
      new T.MeshLambertMaterial({ color: 0xe8d9a8, flatShading: true }),
    );
    mesh.geometry.rotateX(Math.PI / 2);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.arrows.push({ mesh, vel, life: 4 });
  }

  /** Fire down the centre of the view. */
  fire(): boolean {
    if (this.over) return false;
    /*
     * One arrow at a time.
     *
     * A longbow is not a machine gun, and without this the honest answer to
     * every target is to click as fast as the mouse allows. Making you wait
     * for the nock is what turns aiming into a decision.
     */
    if (this.drawn < 0.5) return false;
    this.shots += 1;
    /*
     * Matrices first.
     *
     * Rotation is written in the render loop, and a shot fired between frames
     * raycasts through whatever the camera's world matrix last said — which is
     * where you were looking a frame ago, not where the reticle is. That is
     * why shooting appeared not to work: the ray was real and pointed slightly
     * wrong, so it missed everything that looked dead centre.
     */
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.aim, this.camera);
    const faces = this.butts.filter((b) => b.dead <= 0 && b.out > 0.15).map((b) => b.face);
    this.drawn = 0;
    this.sfx?.loose();
    let target = this.raycaster.intersectObjects(faces, false)[0]?.object as T.Mesh | undefined;

    /*
     * Aim assist, and why an arcade needs it.
     *
     * A raycast down the exact centre pixel is how a simulation decides a hit.
     * It is far stricter than it looks: the reticle is 22 pixels across, a
     * butt forty units away is barely wider, and a shot that visibly clipped
     * the straw returns nothing. That reads as "shooting doesn't work" even
     * though every shot was real.
     *
     * So if the ray misses, take the nearest face within a small angle of
     * where you were looking. Every arcade shooter does this; the ones that
     * feel accurate are the ones doing the most of it.
     */
    if (!target) {
      const dir = this.raycaster.ray.direction;
      let best = Math.cos(0.045); // ~2.6 degrees
      for (const f of faces) {
        const to = f.getWorldPosition(new T.Vector3()).sub(this.camera.position).normalize();
        const dot = to.dot(dir);
        if (dot > best) {
          best = dot;
          target = f;
        }
      }
    }

    if (!target) {
      this.combo = 0;
      this.sfx?.miss();
      this.onChange(this.snapshot());
      return false;
    }
    this.sfx?.thunk();
    if (this.combo >= 1) this.sfx?.chime(this.combo);
    const b = this.butts.find((x) => x.face === target)!;
    b.dead = 0.6;
    this.hits += 1;
    this.combo += 1;
    const move = Math.abs(b.stock.changePct);
    const base = Math.round(40 + move * 60);
    this.points += Math.round((b.hostile ? base * 1.6 : base) * (1 + this.combo * 0.08));
    this.onChange(this.snapshot());
    return true;
  }

  resize() {
    const w = this.canvas.clientWidth || 960;
    const h = this.canvas.clientHeight || 560;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.onChange(this.snapshot());
    let since = 0;
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);

      // Ease the field of view rather than snapping it: a scope that changes
      // magnification instantly reads as a glitch.
      const want = this.scoped ? FOV_SCOPE : FOV_WIDE;
      this.camera.fov += (want - this.camera.fov) * Math.min(1, dt * 9);
      this.camera.updateProjectionMatrix();
      this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");

      this.renderer.render(this.scene, this.camera);
      since += dt;
      if (since >= 0.1 && !this.over) {
        since = 0;
        this.onChange(this.snapshot());
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }
}
