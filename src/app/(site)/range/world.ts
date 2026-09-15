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
import { buildWood, rand } from "./scene";
import {
  LANES,
  makeButt,
  tickerLabel,
  ringColourFor,
  ringOf,
  ringMultiplier,
  comboAfter,
  streakAfter,
  FACE_RADIUS,
  type Butt,
} from "./butts";
import {
  makeArrowMesh,
  looseEnemyArrow,
  stepArrows,
  drawSpeed,
  drawShake,
  ARROW_LIFE,
  type Arrow,
} from "./arrows";

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
  /** The best combo reached this round, surviving whatever miss ended it.
      Not shown this phase — carried for Phase 3's results card. */
  streak: number;
  /** The best (lowest-numbered, so 1 is gold) ring struck this round.
      0 means nothing has been struck yet. Phase 3 only. */
  bestRing: number;
  /** The ticker whose single hit earned the most points this round.
      Empty until the first hit lands. Phase 3 only. */
  bestSymbol: string;
  msLeft: number;
  over: boolean;
  /** Bumped on every hit, so the marker can flash without a callback. */
  mark: number;
  markKill: boolean;
  /** How much of the flinch is left, 0..1, for the damage vignette. */
  hurt: number;
  /** How far the string is drawn back right now, 0..1. 0 whenever not drawing. */
  draw: number;
}

export const ROUND_MS = 60_000;
const START_LIVES = 3;
/** Field of view wide, and narrowed when the scope is up. */
const FOV_WIDE = 72;
const FOV_SCOPE = 26;

/** How long the flinch lasts, and the window in which nothing else can land. */
const HURT_TIME = 0.7;

/** How long a full pull takes, held down. */
const DRAW_TIME = 0.7;
/** Short of this, letting go abandons the shot rather than loosing a feeble one. */
const MIN_LOOSE_DRAW = 0.15;
/** How much the field of view narrows at a full draw, on top of the scope. */
const DRAW_FOV_NARROW = 4;
/** The camera kick on release, and how long it takes to settle back down. */
const RELEASE_KICK = (0.9 * Math.PI) / 180;
const RELEASE_KICK_TIME = 0.2;
/** How long the nock takes to refill after a shot — the rate-of-fire limit. */
const NOCK_TIME = 0.42;
/** What a tap on a touchscreen looses at — a solid, deliberate pull with no wait. */
const TOUCH_DRAW = 0.8;

/** How long a struck (but not destroyed) butt takes to settle back upright. */
const ROCK_TIME = 0.4;
/** How far back it recoils at the moment of impact, in radians. */
const ROCK_ANGLE = (16 * Math.PI) / 180;
/** How long the points popup takes to fade out entirely. */
const POPUP_LIFE = 0.9;
/** How fast the points popup drifts upward off the face, in world units/second. */
const POPUP_RISE = 2.2;

export class World {
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera: T.PerspectiveCamera;
  private raycaster = new T.Raycaster();
  private butts: Butt[] = [];
  private arrows: Arrow[] = [];
  /** Points popups floating up off a struck face — a sprite each, aged out
      and disposed once they finish fading rather than left to accumulate. */
  private popups: { sprite: T.Sprite; age: number }[] = [];
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
  streak = 0;
  bestRing = 0;
  bestSymbol = "";
  /** The points a single hit earned `bestSymbol` — kept only to decide
      whether a new hit's symbol displaces the old one, never shown itself. */
  private bestSymbolPoints = 0;
  msLeft = ROUND_MS;
  over = false;
  /** Read it, but set it through setScoped so the view can follow. */
  scoped = false;
  /** Seconds of red flash left after taking an arrow. */
  hurt = 0;
  /** The bow in your hands, and how far through nocking the next arrow it is. */
  private bow: T.Group | null = null;
  private nock: T.Mesh | null = null;
  /**
   * `drawn` and `draw` are one letter apart and mean different things — easy
   * to conflate, so spelled out here:
   *   `drawn`  — the nock's own refill, 0..1, climbing back to 1 on its own
   *              after every shot. This is the rate-of-fire gate; it has
   *              nothing to do with how hard the string was pulled.
   *   `draw`   — how far the string is pulled back right now, 0..1, driven
   *              entirely by `beginDraw`/`releaseDraw` holding a button down.
   * A shot needs `drawn` to be (nearly) full before it can begin, and its
   * speed is set by `draw` — two independent numbers doing two different jobs.
   */
  private drawn = 1;
  private draw = 0;
  /** True while the draw is being held; false the instant it looses or is abandoned. */
  private drawing = false;
  /** Seconds the current (or just-released) draw has been held, for `drawShake`. */
  private heldSeconds = 0;
  /** 1 right after a release, decaying to 0 over `RELEASE_KICK_TIME` — the recoil settling. */
  private kick = 0;
  private mark = 0;
  private markKill = false;
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
  sfx: {
    loose(): void;
    thunk(): void;
    miss(): void;
    hurt(): void;
    chime(n: number): void;
    horn(): void;
    marker(kill?: boolean): void;
    /** As the string comes back, 0..1. Optional: not every sound bench build has it. */
    creak?(draw: number): void;
  } | null = null;

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
    // stepArrows finds the player by this flag, so a hostile arrow's
    // proximity check has an Object3D to measure against.
    this.camera.userData.isPlayer = true;
    const wood = buildWood(this.scene);
    this.tagGround(wood.root);
    this.buildBow();
    this.resize();
  }

  /**
   * Mark the one mesh in the wood an arrow can stick into short of a butt.
   *
   * scene.ts builds the whole wood, ground included, without any of it
   * knowing that arrows exist — so the ground is picked out here by shape
   * (a big flat plane) rather than by scene.ts tagging itself for a concern
   * that lives in this file.
   */
  private tagGround(root: T.Group) {
    for (const child of root.children) {
      if (!(child instanceof T.Mesh) || !(child.geometry instanceof T.PlaneGeometry)) continue;
      if (child.geometry.parameters.width > 100) child.userData.arrowGround = true;
    }
  }

  private snapshot(): Snapshot {
    return {
      points: this.points,
      health: this.health,
      lives: this.lives,
      hits: this.hits,
      shots: this.shots,
      combo: this.combo,
      streak: this.streak,
      bestRing: this.bestRing,
      bestSymbol: this.bestSymbol,
      msLeft: this.msLeft,
      over: this.over,
      mark: this.mark,
      markKill: this.markKill,
      hurt: Math.max(0, Math.min(1, this.hurt / HURT_TIME)),
      draw: this.draw,
    };
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
    const g = new T.Group();
    /*
     * Where a bow actually is when you are holding it.
     *
     * Close enough that the limbs run off the top and bottom of the view,
     * canted rather than upright, and off to the right so it does not sit in
     * front of what you are shooting at. The first attempt was a torus
     * segment with a straight string floating beside it, which read as a
     * croissant.
     */
    g.scale.setScalar(0.42);
    g.position.set(0.44, -0.56, -1.1);
    g.rotation.set(0.02, -0.2, -0.12);
    this.bow = g;
    this.camera.add(g);
    this.scene.add(this.camera);

    // Something in your hands immediately, in case the model never arrives.
    const stand = this.roughBow();
    g.add(stand);

    /*
     * The arrow hangs off the camera, not off the bow.
     *
     * It has to point where the shot goes — straight into the screen — and
     * the bow is canted, so an arrow parented to it comes out crossing the
     * view diagonally, which is what the first attempt looked like. Keeping
     * it on the camera means its direction is simply forward.
     */
    this.nock = makeArrowMesh();
    /*
     * Near the line of sight, because that is where a nocked arrow is.
     *
     * Offset far to the side it projects as a long diagonal radiating out of
     * the middle of the screen — correct perspective for a shaft pointing
     * forward a long way off-axis, and completely wrong for something you are
     * about to shoot along. Close to the axis it foreshortens into the short
     * stub you actually see over a bow.
     */
    this.nock.position.set(0.12, -0.2, -1.05);
    this.nock.rotation.set(0, 0.015, 0);
    this.camera.add(this.nock);

    /*
     * The real bow: 660 triangles of CC0 low-poly from Quaternius, loaded
     * after the first frame rather than before it. A round that will not
     * start until a download finishes is worse than one that starts with a
     * placeholder and improves a moment later.
     */
    void import("three/examples/jsm/loaders/GLTFLoader.js")
      .then(({ GLTFLoader }) => new GLTFLoader().loadAsync("/arcade/bow.glb"))
      .then((gltf) => {
        const m = gltf.scene;
        /*
         * The pack's wood is almost black in linear space, which disappears
         * against a dusk-lit wood. Lambert at a lifted colour matches the
         * flat-shaded look of everything else here, and the string is left
         * unlit so it stays a visible line rather than a dark smudge.
         */
        m.traverse((o) => {
          const mesh = o as T.Mesh;
          if (!mesh.isMesh) return;
          const name = (mesh.material as T.Material)?.name ?? "";
          mesh.material =
            name === "White"
              ? new T.MeshBasicMaterial({ color: 0xe3dcc4 })
              : new T.MeshLambertMaterial({
                  color: name === "LightWood" ? 0x9c6b3f : 0x5d3c22,
                  flatShading: true,
                });
        });
        // Centre it on its own bounding box so the grip, not the origin,
        // is what sits where we put it.
        const box = new T.Box3().setFromObject(m);
        m.position.sub(box.getCenter(new T.Vector3()));
        g.remove(stand);
        g.add(m);
      })
      .catch(() => {
        // Keep the placeholder. A bow that failed to download is not a
        // reason to be unable to play.
      });
  }

  /** The fallback bow, and the nocked arrow's shape. */
  private roughBow(): T.Group {
    const wood = new T.MeshLambertMaterial({ color: 0x6b4a2a, flatShading: true });
    const g = new T.Group();
    const stave = new T.Mesh(new T.TorusGeometry(0.95, 0.05, 5, 20, Math.PI * 1.1), wood);
    stave.rotation.z = -Math.PI * 0.05;
    g.add(stave);
    const string = new T.Mesh(
      new T.CylinderGeometry(0.008, 0.008, 1.8, 3),
      new T.MeshBasicMaterial({ color: 0xd9d2bc }),
    );
    string.position.set(-0.66, 0, 0);
    g.add(string);
    return g;
  }

  private spawn() {
    if (!this.stocks.length) return;
    /*
     * Half the range should be shooting back.
     *
     * Hostility is real: a butt is red because the share is down today. But
     * on a green day that left almost nothing firing, and the game stopped
     * being a game. So the draw is biased — still a real ticker that really
     * is down, just picked for more often than chance would.
     */
    const down = this.stocks.filter((x) => x.changePct < 0);
    const up = this.stocks.filter((x) => x.changePct >= 0);
    const wantHostile = down.length > 0 && (up.length === 0 || Math.random() < 0.45);
    const pool = wantHostile ? down : up.length ? up : this.stocks;
    const stock = pool[Math.floor(Math.random() * pool.length)];
    const lane = Math.floor(Math.random() * LANES.length);
    const x = rand(-30, 30);
    const butt = makeButt(stock, lane, x);
    // stepArrows steers the player's own shots toward whatever carries this
    // flag, and raycasts every arrow's flight against it.
    butt.face.userData.arrowTarget = true;
    this.scene.add(butt.group);
    this.butts.push(butt);
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
    const dx = x - this.cursor.x;
    const dy = y - this.cursor.y;
    this.cursor.set(x, y);

    /*
     * Scoped, the cursor pans the view; unscoped, it *is* the aim.
     *
     * This is why shooting stopped working through the scope. Raising it
     * swung the view to the cursor and put the shot back down the middle —
     * and then the very next mouse movement called this, which reset the aim
     * to wherever the cursor happened to be. So the reticle in the middle of
     * the glass said one thing and the arrow went somewhere else entirely.
     */
    if (this.scoped) {
      this.aim.set(0, 0);
      this.turn(-dx * 0.9, -dy * 0.5);
      return;
    }
    this.aim.set(x * 2 - 1, -(y * 2 - 1));
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

  /** Turn the head by an amount in radians, clamped to keep the range ahead. */
  private turn(dyaw: number, dpitch: number) {
    this.yaw = Math.max(-0.85, Math.min(0.85, this.yaw + dyaw));
    this.pitch = Math.max(-0.32, Math.min(0.28, this.pitch + dpitch));
  }

  /** Look, from a locked pointer's relative movement in pixels. */
  look(dx: number, dy: number) {
    this.aim.set(0, 0);
    const k = this.scoped ? 0.0009 : 0.0022;
    this.turn(-dx * k, -dy * k);
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
    if (this.drawn < 1) this.drawn = Math.min(1, this.drawn + dt / NOCK_TIME);

    /*
     * Holding the draw.
     *
     * A separate thing from nocking: the nock is the rate-of-fire gate that
     * keeps this from being a machine gun, and only once it is full can a new
     * draw even begin (see `beginDraw`). This is what happens after that —
     * the deliberate pull that makes a full draw something you wait for.
     */
    if (this.drawing) {
      this.heldSeconds += dt;
      this.draw = Math.min(1, this.draw + dt / DRAW_TIME);
      this.sfx?.creak?.(this.draw);
    }
    if (this.kick > 0) this.kick = Math.max(0, this.kick - dt / RELEASE_KICK_TIME);

    if (this.bow) {
      this.bow.visible = !this.scoped;
      const nockKick = (1 - this.drawn) * (1 - this.drawn);
      this.bow.position.set(0.44 + nockKick * 0.06, -0.56 - nockKick * 0.03, -1.1 + nockKick * 0.1);
      // The bow bends as the string comes back: the whole rig cants a little
      // further, rather than just the string moving, so the draw reads in the
      // shape of the bow and not only in the meter.
      this.bow.rotation.set(0.02, -0.2 - this.draw * 0.06, -0.12);
      if (this.nock) {
        this.nock.visible = !this.scoped && this.drawn > 0.55;
        // Pulled back toward the eye as the draw builds, forward again as it eases off.
        this.nock.position.set(0.12, -0.2, -1.05 + this.draw * 0.16);
      }
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
      /*
       * Butts come up in volleys, not one at a time.
       *
       * Singles meant the range was almost always empty and there was never a
       * choice to make: shoot the one thing that is up. Two or three at once —
       * a red and a green together, or two reds on different lanes — is where
       * the decision is, because the red one is shooting at you while you
       * line up the green one that is worth more.
       */
      const progress = 1 - this.msLeft / ROUND_MS;
      const volley = 1 + (Math.random() < 0.35 + progress * 0.4 ? 1 : 0) + (Math.random() < progress * 0.45 ? 1 : 0);
      for (let i = 0; i < volley; i++) this.spawn();
      this.spawnIn = rand(0.5, 1.2) * (1 - progress * 0.45);
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
      b.group.position.set(b.x, -9 + b.out * 9, LANES[b.lane]);
      // The recoil from being struck: a kick back on impact (rock reset to
      // 0 in onArrowHit), easing out to upright again over ROCK_TIME. A
      // butt that has not been hit this cycle just sits at rock === 1,
      // where the eased angle is already zero, so this is safe to run
      // unconditionally rather than branching on whether it was ever hit.
      if (b.rock < 1) b.rock = Math.min(1, b.rock + dt / ROCK_TIME);
      const settle = 1 - b.rock;
      b.group.rotation.x = -ROCK_ANGLE * settle * settle;
      // Only a butt that is actually up and not already falling is
      // something a flying arrow should be steered toward or able to hit —
      // the same condition fire() used to filter its raycast targets by.
      b.face.userData.arrowTarget = b.dead <= 0 && b.out > 0.15;

      if (b.hostile && b.out > 0.6) {
        b.cooldown -= dt;
        if (b.cooldown <= 0) {
          b.cooldown = rand(0.7, 1.3);
          this.arrows.push(looseEnemyArrow(this.scene, b, this.camera.position));
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

    /*
     * One integrator for both sides.
     *
     * The player's shots and a hostile butt's shots are the same kind of
     * object flying under the same gravity, so they are stepped, spun and
     * collision-tested together here rather than in two loops that would
     * have to be kept in sync by hand — which is exactly how the segment
     * test below would have ended up covering only one of them.
     */
    stepArrows(this.arrows, dt, this.scene, (a, hit, point) => this.onArrowHit(a, hit, point));
    this.stepPopups(dt);
  }

  /**
   * Drift and fade the points popups, disposing each one the instant it
   * finishes rather than leaving a growing pile of dead sprites behind —
   * the same cap-and-clean discipline `stepArrows` already applies to
   * arrows, applied here to the other thing a hit spawns.
   */
  private stepPopups(dt: number) {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.age += dt;
      p.sprite.position.y += dt * POPUP_RISE;
      const mat = p.sprite.material as T.SpriteMaterial;
      mat.opacity = Math.max(0, 1 - p.age / POPUP_LIFE);
      if (p.age >= POPUP_LIFE) {
        this.disposePopup(p);
        this.popups.splice(i, 1);
      }
    }
  }

  private disposePopup(p: { sprite: T.Sprite; age: number }) {
    this.scene.remove(p.sprite);
    const mat = p.sprite.material as T.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  }

  /**
   * The ticker chip that pops off a struck face: a sprite showing the
   * points just earned, on a short upward path that fades. Reuses
   * `tickerLabel`'s canvas-texture rendering rather than a second way of
   * drawing text to a texture — fed the points string instead of a symbol.
   */
  private spawnPopup(b: Butt, gained: number, colour: string) {
    const tex = tickerLabel(`+${gained}`, colour);
    const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new T.Sprite(mat);
    sprite.scale.set(2.2, 2.2, 1);
    sprite.position.copy(b.face.getWorldPosition(new T.Vector3()));
    this.scene.add(sprite);
    this.popups.push({ sprite, age: 0 });
  }

  /**
   * What an arrow's flight resolved to: a butt, the ground, the player, or
   * nothing at all.
   *
   * This is where the scoring used to live inside `fire()`, moved here
   * unchanged because a shot's outcome is no longer known the instant it is
   * loosed — only once the arrow actually arrives somewhere.
   */
  private onArrowHit(a: Arrow, hit: T.Object3D, point?: T.Vector3) {
    if (a.mine) {
      const b = this.butts.find((x) => x.face === hit);
      if (!b) {
        // Landed in the dirt, or flew clean past everything: a miss, same
        // as the old instant hitscan's miss. The streak already reached is
        // kept — only the live combo dies here.
        this.streak = streakAfter(false, this.combo, this.streak);
        this.combo = comboAfter(false, this.combo);
        this.sfx?.miss();
        this.onChange(this.snapshot());
        return;
      }
      this.sfx?.thunk();
      /*
       * The chime marks a streak, not a hit.
       *
       * It used to sound on every single one, which put a third voice on top
       * of the marker and the arrow landing and turned a confirmation into
       * noise. Every fifth makes it mean something when it does arrive.
       */
      if (this.combo >= 5 && this.combo % 5 === 0) this.sfx?.chime(this.combo);

      // Where on the face it struck, not just which face — a raycast always
      // hands stepArrows a real intersection point for an object hit, but
      // the fallback keeps a missing one from ever crashing this out to
      // something other than the most generous ring.
      const centre = b.face.getWorldPosition(new T.Vector3());
      const distanceFromCentre = point ? point.distanceTo(centre) : 0;
      const ring = ringOf(distanceFromCentre, FACE_RADIUS);
      const multiplier = ringMultiplier(ring);

      this.hits += 1;
      this.streak = streakAfter(true, this.combo, this.streak);
      this.combo = comboAfter(true, this.combo);
      this.mark += 1;
      this.markKill = b.hostile;
      // The gold ring gets the same brighter marker a kill does — both mean
      // "that was a good one".
      this.sfx?.marker(b.hostile || ring === 1);

      const move = Math.abs(b.stock.changePct);
      const base = Math.round(40 + move * 60);
      const gained = Math.round((b.hostile ? base * 1.6 : base) * (1 + this.combo * 0.08) * multiplier);
      this.points += gained;

      if (this.bestRing === 0 || ring < this.bestRing) this.bestRing = ring;
      if (gained > this.bestSymbolPoints) {
        this.bestSymbolPoints = gained;
        this.bestSymbol = b.stock.symbol;
      }

      this.spawnPopup(b, gained, ringColourFor(b.hostile));

      if (b.hostile) {
        // Destroyed and stops shooting, as before — the fall-and-remove
        // animation already driven by `dead` in `step()`.
        b.dead = 0.6;
      } else {
        // A green hit scores and reacts, but the target itself survives to
        // be shot again before its own dwell timer sends it back down.
        b.rock = 0;
      }
      this.onChange(this.snapshot());
      return;
    }

    if (hit === this.scene) {
      // Gone past and behind without hitting anything: it missed, and
      // saying so is what makes a near miss feel like one.
      this.sfx?.miss();
      return;
    }
    if (hit !== this.camera) return; // a hostile shot stuck a butt or the ground: nothing to do
    /*
     * A moment's grace after being hit.
     *
     * Three reds firing together emptied the bar in under ten seconds of
     * a sixty second round, which is not difficulty, it is not getting to
     * play. The arrow still dies, so volleys are still punished — they
     * just cannot all land at once.
     */
    if (this.hurt > 0) return;
    this.health = Math.max(0, this.health - 18);
    this.combo = 0;
    this.points = Math.max(0, this.points - 250);
    this.hurt = HURT_TIME;
    this.sfx?.hurt();
    if (this.health <= 0) this.lives = 0;
    this.onChange(this.snapshot());
  }

  /**
   * Start pulling the string back.
   *
   * Gated on the nock being completely full, not just past the rate-of-fire
   * threshold `fire` itself uses — you cannot begin a new draw while the
   * last arrow is still on its way back onto the string.
   */
  beginDraw(): void {
    if (this.over || this.drawing || this.drawn < 1) return;
    this.drawing = true;
    this.draw = 0;
    this.heldSeconds = 0;
  }

  /**
   * Throw away a held draw without ever loosing it — no `fire` call, whatever
   * `draw` had reached.
   *
   * This is not a second way to end a draw with a shot; it is the one way to
   * end a draw with nothing. It exists because the cursor leaving the canvas
   * is an ordinary thing that happens mid-hold — tracking a target near the
   * edge, or just not being under pointer lock — and `releaseDraw` looses
   * whenever the pull passed `MIN_LOOSE_DRAW`, which is nearly any real hold.
   * Routing a canvas exit through `releaseDraw` would spend an arrow on
   * exactly the stray input `MIN_LOOSE_DRAW` exists to filter out of clicks.
   */
  cancelDraw(): void {
    this.drawing = false;
    this.draw = 0;
    this.heldSeconds = 0;
  }

  /**
   * Let go of a held draw.
   *
   * Reaching `MIN_LOOSE_DRAW` looses the arrow at whatever strength the draw
   * had reached; short of that, there is nothing to loose and the draw is
   * simply abandoned — closer to a string slipping off a slack finger than a
   * shot. Either way the draw itself resets, ready to begin again once the
   * nock is full.
   */
  releaseDraw(): boolean {
    if (!this.drawing) return false;
    this.drawing = false;
    const draw = this.draw;
    const heldSeconds = this.heldSeconds;
    this.draw = 0;
    this.heldSeconds = 0;
    if (draw < MIN_LOOSE_DRAW) return false;
    const shot = this.fire(draw, false, heldSeconds);
    if (shot) this.kick = 1;
    return shot;
  }

  /**
   * A tap on a touchscreen.
   *
   * A thumb is also the thing doing the aiming, so there is no holding a
   * draw without losing the aim along with it — one tap looses immediately,
   * at a solid fixed pull rather than the flinch-quick snap a bare click
   * would otherwise give you.
   */
  touchFire(): boolean {
    return this.fire(TOUCH_DRAW, true);
  }

  /**
   * Loose an arrow down the centre of the view, at `draw` strength.
   *
   * The single place a shot is actually loosed — `releaseDraw` and
   * `touchFire` both end up here rather than each flying their own arrow.
   */
  fire(draw = 1, touch = false, heldSeconds = 0): boolean {
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
    this.drawn = 0;
    this.sfx?.loose();

    /*
     * Aim assist, and why an arcade needs it.
     *
     * A raycast down the exact centre pixel used to be how this decided a
     * hit outright: it was far stricter than it looked, since the reticle is
     * 22 pixels across and a butt forty units away is barely wider, so a
     * shot that visibly clipped the straw still returned nothing. That read
     * as "shooting doesn't work" even though every shot was real.
     *
     * A flying arrow cannot be snapped onto a target the instant it leaves
     * the string — there is nothing to snap yet, it has not gone anywhere.
     * So the forgiveness moved from this raycast into `stepArrows`, which
     * steers a loosed arrow toward a nearby target over its flight instead.
     * This is still where the direction comes from, though, which is why
     * the matrix note above still matters.
     */
    const from = this.nock?.getWorldPosition(new T.Vector3()) ?? this.camera.position.clone();
    const dir = this.raycaster.ray.direction.clone();
    /*
     * The cost of an overheld draw.
     *
     * `drawShake` is 0 until well past a full draw, so a normal shot — held
     * for less than the time it takes to actually pull the string back — is
     * never touched by this. Only holding at full draw and waiting for a
     * certainty wanders the aim, which is the whole point of it existing.
     */
    const shake = drawShake(heldSeconds);
    if (shake > 0) {
      const wobble = new T.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      dir.applyAxisAngle(wobble, shake * Math.random()).normalize();
    }
    const vel = dir.multiplyScalar(drawSpeed(draw));
    const mesh = makeArrowMesh();
    mesh.position.copy(from);
    mesh.lookAt(from.clone().add(vel));
    this.scene.add(mesh);
    this.arrows.push({ mesh, vel, life: ARROW_LIFE, mine: true, stuck: 0, spin: rand(2, 5), touch });
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
      // magnification instantly reads as a glitch. Drawing narrows it too, a
      // little — the world closing in as the shot comes together.
      const want = this.scoped ? FOV_SCOPE : FOV_WIDE - this.draw * DRAW_FOV_NARROW;
      this.camera.fov += (want - this.camera.fov) * Math.min(1, dt * 9);
      this.camera.updateProjectionMatrix();
      // The release kick rides on top of the aimed pitch rather than changing
      // it, so it settles back to exactly where you were looking rather than
      // leaving the view drifted.
      this.camera.rotation.set(this.pitch - this.kick * RELEASE_KICK, this.yaw, 0, "YXZ");

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
    // Whatever popups had not finished fading do not get another frame to
    // do so — free their textures now rather than leaking them.
    for (const p of this.popups) this.disposePopup(p);
    this.popups = [];
    this.renderer.dispose();
  }
}
