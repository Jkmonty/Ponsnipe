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
const LANES = [-22, -34, -48];

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
  lives = START_LIVES;
  hits = 0;
  shots = 0;
  combo = 0;
  msLeft = ROUND_MS;
  over = false;
  scoped = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private stocks: Stock[],
    private onChange: (s: Snapshot) => void,
  ) {
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new T.PerspectiveCamera(FOV_WIDE, 1, 0.1, 400);
    this.camera.position.set(0, 3.2, 6);
    this.buildWorld();
    this.resize();
  }

  private snapshot(): Snapshot {
    return {
      points: this.points,
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
      this.tree(rand(-90, 90), rand(-140, -8));
    }
    for (let i = 0; i < 40; i++) {
      this.rock(rand(-70, 70), rand(-90, -6));
    }
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
      new T.CircleGeometry(1.9, 18),
      new T.MeshLambertMaterial({ map: this.label(stock.symbol, ringColour), flatShading: true }),
    );
    face.position.y = 3.4;
    group.add(face);

    const rim = new T.Mesh(
      new T.TorusGeometry(1.95, 0.16, 6, 20),
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
    this.yaw = (0.5 - Math.max(0, Math.min(1, fx))) * 1.7;
    this.pitch = (0.5 - Math.max(0, Math.min(1, fy))) * 0.6 - 0.02;
  }

  /** Look. Yaw and pitch are clamped so the range stays in front of you. */
  look(dx: number, dy: number) {
    this.yaw = Math.max(-0.85, Math.min(0.85, this.yaw - dx * (this.scoped ? 0.0009 : 0.0022)));
    this.pitch = Math.max(-0.32, Math.min(0.28, this.pitch - dy * (this.scoped ? 0.0009 : 0.0022)));
  }

  private step(dt: number) {
    if (this.over) return;
    this.msLeft -= dt * 1000;
    if (this.msLeft <= 0 || this.lives <= 0) {
      this.msLeft = Math.max(0, this.msLeft);
      this.over = true;
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
      a.mesh.position.addScaledVector(a.vel, dt);
      a.mesh.lookAt(a.mesh.position.clone().add(a.vel));
      a.life -= dt;
      // Past the camera plane and close to the eye is a hit.
      if (a.mesh.position.z > this.camera.position.z - 0.8) {
        const miss = a.mesh.position.distanceTo(this.camera.position);
        a.life = 0;
        if (miss < 2.2) {
          this.lives -= 1;
          this.combo = 0;
          this.points = Math.max(0, this.points - 250);
          this.onChange(this.snapshot());
        }
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
    this.shots += 1;
    this.raycaster.setFromCamera(new T.Vector2(0, 0), this.camera);
    const faces = this.butts.filter((b) => b.dead <= 0 && b.out > 0.15).map((b) => b.face);
    const hit = this.raycaster.intersectObjects(faces, false)[0];
    if (!hit) {
      this.combo = 0;
      this.onChange(this.snapshot());
      return false;
    }
    const b = this.butts.find((x) => x.face === hit.object)!;
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
