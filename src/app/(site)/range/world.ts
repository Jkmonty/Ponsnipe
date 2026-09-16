/**
 * Sherwood in three dimensions.
 *
 * The flat version read as what it was: shapes on a plane. Depth is the whole
 * difference — a target behind a trunk is genuinely behind it, the scope
 * narrows the field of view rather than drawing a smaller circle, and an arrow
 * coming at you grows.
 *
 * This file is the game itself: the render loop, the camera and the bow,
 * spawning and retiring butts, stepping arrows, and turning a credited hit
 * into score, health and the HUD's snapshot. The wood the range stands in —
 * the trees, hedges, ground and everything else built once out of primitive
 * geometry and never moved — lives in `scene.ts`; this file only asks for it,
 * tags the one mesh in it an arrow can stick into (the ground), and disposes
 * it when the round ends.
 *
 * Three.js only lives on this route, so the terminal's bundle never sees it.
 */
import * as T from "three";
import { buildWood, disposeWood, stepWood, type Wood } from "./scene";
import { rand } from "./rand";
import type { Surface } from "./render";
import {
  makeButt,
  ringColourFor,
  ringOf,
  resolveButtHit,
  comboAfter,
  streakAfter,
  applyButtHit,
  disposeButt,
  bestSymbolAfter,
  stepButt,
  pickBehaviour,
  FACE_RADIUS,
  RANKS,
  type Butt,
  type Rank,
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
import { waveAt, type WaveState } from "./waves";

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
  /** The ticker with the highest cumulative points earned this round — the
      running total per symbol, not whichever one happened to hand back a
      single big hit. Empty until the first hit lands. Phase 3 only. */
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
  /** True while the world is only running to be looked at: no round has
      started, the clock is frozen, nothing hostile can spawn or fire, and no
      hit can change points or health. The overlay reads this to know it
      should still be showing the start screen rather than the HUD. */
  attract: boolean;
  /** Which wave is running, 0..2, so the HUD can tighten in the storm.
      Stays 0 through the whole of attract mode, the same as `msLeft`
      staying at `ROUND_MS` — the clock that would advance it never runs. */
  wave: number;
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

/**
 * How long a hostile butt winds up — face turning to the player, rim glow
 * rising — before it actually looses. Exported so the wind-up-then-loose
 * regression test in `tests/range.test.ts` can reason about it directly
 * rather than hard-coding a copy of the number that could silently drift
 * from the real one.
 */
export const TELL_MS = 900;

/** How far either side of centre a sidestep may reach — the full answer to
    an incoming arrow, not a token nudge (see the escape arithmetic in the
    task-3 report). */
const SIDESTEP_MAX = 3;
/** Units per second while a sidestep direction is held — a full ±3 unit
    dodge takes exactly `SIDESTEP_MAX / SIDESTEP_SPEED` seconds (a third of
    a second), which is what the escape arithmetic is measured against. */
const SIDESTEP_SPEED = 9;
/** How fast the sidestep eases back to centre once released. Slower than
    `SIDESTEP_SPEED`: getting back to centre is never itself racing a
    clock the way getting out of the way is. */
const SIDESTEP_RETURN_EASE = 6;

/** Below this canvas width the 2048² shadow map halves to 1024² — the same
    breakpoint the site's own CSS treats as "small", and a width where the
    map's own resolution was never the thing making a shadow read as sharp.
    A full-width stage at this size is still doubling the pixel count of a
    round's worth of shadow-mapped geometry for no visible gain. */
const SHADOW_DROP_WIDTH = 720;

/**
 * Whether the nock is back far enough to loose another arrow — the single
 * rate-of-fire gate for both the mouse path (`beginDraw`/`releaseDraw`) and
 * the touch path (`touchFire`).
 *
 * It used to be two different numbers in two different places: `fire` itself
 * only asked for half a nock (`drawn < 0.5`), which was invisible while the
 * only way in was `beginDraw`'s own stricter `drawn < 1` gate — a mouse
 * always cleared 0.5 long before it could finish a real pull anyway. But
 * `touchFire` calls `fire` directly, skipping `beginDraw` entirely, so it
 * walked straight through the loose half of the door: a tapping phone could
 * loose a shot every 210ms, against a mouse's own ~525ms floor of a full
 * nock plus the minimum pull. Nothing legitimate needs the half-nock door,
 * so both paths now ask this one function the same question.
 */
export function nockReady(drawn: number): boolean {
  return drawn >= 1;
}

/**
 * What one frame of `step` is allowed to change while the world is only
 * there to look at.
 *
 * Pulled out as a pure function for exactly the reason `resolveButtHit` and
 * `isTargetable` were: there is no way to drive a render loop in this test
 * runner (it needs a real WebGL canvas), but the *decision* a render loop
 * would make needs no canvas at all. `step` calls this once per frame and
 * consults every field of the result rather than checking `attracting`
 * itself in more than one place, so "what attract mode turns off" has
 * exactly one definition instead of one per call site that could drift.
 */
export interface AttractGates {
  /** Seconds the round clock may advance by this frame — `dt` outside
      attract, and always exactly 0 while attracting. "The clock does not
      run" is precisely this being 0, however large or small `dt` is. */
  clockDt: number;
  /** Whether a butt may come up hostile this frame, or an already-hostile
      one may loose a shot. False for the whole of attract mode, so nothing
      red ever fires — and, since `spawn` reads this too, nothing red even
      appears. */
  hostileActive: boolean;
  /** Whether a credited hit, on either side, may change points or health
      this frame. False for the whole of attract mode: whatever else might
      reach `onArrowHit`, this is what keeps the score and the health bar
      from moving. */
  consequencesActive: boolean;
}

export function attractStep(state: { attracting: boolean }, dt: number): AttractGates {
  const live = !state.attracting;
  return { clockDt: live ? dt : 0, hostileActive: live, consequencesActive: live };
}

/** How long the recoil on impact takes to settle back upright — the butt
    still rocks even on a hit that goes on to destroy it. */
const ROCK_TIME = 0.4;
/**
 * How far back it recoils at the moment of impact, in radians.
 *
 * 16 degrees was the first guess and read as barely there once a butt is
 * its normal distance away and small on screen — by the time a screenshot
 * or even a glance lands mid-animation it had already settled most of the
 * way back. 28 degrees is what actually reads as a flinch at range without
 * looking like the post snapped.
 */
const ROCK_ANGLE = (28 * Math.PI) / 180;
/** How long the points popup takes to fade out entirely. */
const POPUP_LIFE = 0.9;
/** How fast the points popup drifts upward off the face, in world units/second. */
const POPUP_RISE = 2.2;
/** The points chip's height in world units; its width follows the text's own
    aspect ratio, since it is a chip sized to fit its label, not a square. */
const POPUP_SCALE = 1.1;

/**
 * How far the sun's own intensity is allowed to fall over the course of a
 * round, out of the base 2.4 `scene.ts` builds it at — small on purpose.
 * Golden hour was tuned deliberately in Phase 2 against that exact
 * intensity and the ambient level beside it, and a fix round was needed to
 * get the two reading right together; this is not a second lighting pass,
 * only a late-round cue that the light is dying, read against `elapsed /
 * ROUND_MS` so it lands gradually across the whole round rather than
 * snapping at a wave boundary. At 0.35 out of 2.4 the drop is under 15%,
 * enough to feel like dusk deepening, not enough to fight the shadows and
 * fog `buildWood` already balanced against the brighter number.
 */
const LIGHT_DROP = 0.35;

export class World {
  private scene = new T.Scene();
  private camera: T.PerspectiveCamera;
  private raycaster = new T.Raycaster();
  private _butts: Butt[] = [];
  private _arrows: Arrow[] = [];
  /** Which way the sidestep key is currently held: -1 left, 0 neither, 1
      right. Set by `setStrafe`, which page.tsx calls from keydown/keyup;
      eased toward in `step` rather than applied directly, so letting go
      drifts back to centre instead of snapping. */
  private strafeInput: -1 | 0 | 1 = 0;
  /** The sidestep's own current offset from centre, -`SIDESTEP_MAX` to
      +`SIDESTEP_MAX`, written onto `camera.position.x` every frame. */
  private sideOffset = 0;
  /** Points popups floating up off a struck face — a sprite each, aged out
      and disposed once they finish fading rather than left to accumulate. */
  private popups: { sprite: T.Sprite; age: number }[] = [];
  /** The scenery built once by `buildWood` — kept only so `stop()` can hand
      it to `disposeWood` rather than leaking a round's worth of it. */
  private wood: Wood;
  private raf = 0;
  private running = false;
  /**
   * Once a round ends (`over && !attracting`), `step` and `driftCamera` both
   * return immediately — nothing in the scene changes again until the next
   * `start()` or `attract()` — so rendering past the first idle frame draws
   * an identical image, shadow pass included, sixty times a second for as
   * long as the result card sits on screen. Set the instant a round ends
   * (see `step`) and cleared by the next `start()`/`attract()`; `runLoop`
   * reads it to render exactly one more frame and then stop.
   */
  private renderedFinalFrame = false;
  private last = 0;
  private spawnIn = 0.5;
  /** Head turn, in radians. Clamped so you cannot spin round to the trees behind. */
  private yaw = 0;
  private pitch = 0;
  /** True from `attract()` until `start()` leaves it. See `AttractGates`. */
  private attracting = false;
  /** Elapsed seconds since `attract()` began, driving the camera's own drift
      — kept apart from anything else so it does not reset on a resize or a
      snapshot, only on a fresh `attract()`. */
  private attractT = 0;
  /**
   * Read once at construction. The release kick and the butt's hit-recoil
   * are the two pieces of camera/model shake this round adds that live
   * outside CSS (where `prefers-reduced-motion` is handled generically) — so
   * they are throttled here by hand.
   */
  private reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  points = 0;
  health = 100;
  lives = START_LIVES;
  hits = 0;
  shots = 0;
  combo = 0;
  streak = 0;
  bestRing = 0;
  bestSymbol = "";
  /**
   * Running total earned per ticker this round — not shown itself, fed into
   * `bestSymbolAfter` on every hit to decide whether a symbol's cumulative
   * total now leads. "The ticker that earned the most" means over the whole
   * round, not whichever one happened to hand back a single big hit.
   */
  private symbolPoints = new Map<string, number>();
  private bestSymbolPoints = 0;
  msLeft = ROUND_MS;
  over = false;
  /** The round's current wave, 0..2, read fresh from `waveAt` every frame in
      `step` rather than advanced by hand — `waveAt` is the one place that
      owns the pacing curve, this is only where the last answer it gave is
      kept for `snapshot()`, `spawn()` and the light/music cues to read
      without each calling `waveAt` again themselves. */
  private wave: WaveState = waveAt(0);
  /** The sun's own intensity as `scene.ts` built it, captured once so the
      round's small late-round dimming (`LIGHT_DROP`) has a fixed number to
      fall away from rather than compounding off whatever the last frame
      left it at. */
  private sunBaseIntensity = 0;
  /** The wave last handed to `Sfx.setWave`, so the music is only re-cued on
      an actual wave change rather than every frame — `setWave` schedules a
      Web Audio ramp, and scheduling one sixty times a second for the same
      target would still be harmless but is not what "the music tightens
      for wave 2" means. */
  private lastMusicWave = -1;
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
    /** The incoming whistle of a hostile arrow, called every frame one is in
        flight with its real, current distance to the player — not a fixed
        sweep timed off when it launched, since a far-rank shot has more
        ground to close than a near-rank one. See `step`'s call, right after
        `stepArrows`. */
    whistle(distance: number): void;
    /** Cue the music loop's own tightening for wave 2 — one loop's playback
        rate changing, not a second layer starting. Called once per wave
        change, not every frame (see `lastMusicWave`). Optional: not every
        sound bench build has it, and a fake `sfx` in a test need not either. */
    setWave?(wave: number): void;
  } | null = null;

  constructor(
    private surface: Surface,
    private stocks: Stock[],
    private onChange: (s: Snapshot) => void,
  ) {
    this.camera = new T.PerspectiveCamera(FOV_WIDE, 1, 0.1, 400);
    // Back from the first hedge, so there is ground between you and the
    // nearest butt and the range reads as a range rather than a wall.
    this.camera.position.set(0, 3.6, 20);
    // stepArrows finds the player by this flag, so a hostile arrow's
    // proximity check has an Object3D to measure against.
    this.camera.userData.isPlayer = true;
    this.wood = buildWood(this.scene);
    this.sunBaseIntensity = this.wood.sun.intensity;
    this.tagGround(this.wood.root);
    this.buildBow();
    this.resize();
  }

  /**
   * The butts currently on the range. Read-only, and only ever meant for a
   * test: `world.ts`'s own logic reads and mutates the private list this
   * wraps, never this getter. Exists so `tests/range.test.ts` can drive a
   * real `World` end to end (see `attract()`) and check what it actually
   * did — whether anything hostile came up — without a second copy of
   * `World`'s own spawn/retire logic living in the test file to check it
   * against.
   */
  get butts(): readonly Butt[] {
    return this._butts;
  }

  /** The arrows currently in flight or stuck, for the same reason and the
      same test-only use as `butts` above — in particular, the wind-up
      regression test needs to see that a hostile shot has not appeared in
      here yet while its butt is still winding up. */
  get arrows(): readonly Arrow[] {
    return this._arrows;
  }

  /** The sidestep's current offset from centre, for the same test-only
      reason as `butts`/`arrows` — a test driving `setStrafe` needs to see
      it actually clamp and ease without reaching into `camera.position`
      itself, which is private. */
  get sidestep(): number {
    return this.sideOffset;
  }

  /**
   * A and D, or the left/right arrow keys, held or released — `page.tsx`
   * calls this from its own keydown/keyup handlers (which track both keys
   * itself, so releasing one while the other is still down keeps moving the
   * right way). A no-op while attracting, the same gate `look`, `fire` and
   * `setScoped` already use, so a key held over the menu cannot pre-load a
   * dodge the instant Start is pressed.
   */
  setStrafe(dir: -1 | 0 | 1) {
    if (this.attracting) return;
    this.strafeInput = dir;
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
      attract: this.attracting,
      wave: this.wave.wave,
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

  /**
   * How much of an even 50/50 near/far draw is shifted toward the near
   * rank — the reviewer's call Task 2 deferred to this task, since the
   * split is pacing and pacing is this task's whole subject. The far rank
   * is half the size to hit and worth double, so an even draw handed out
   * the better-paying shot as often as the easy one; weighting it down to
   * roughly a third to two-fifths of spawns (0.38 here) keeps a far target
   * feeling like the one worth reaching for rather than the default. Kept
   * flat across all three waves — the spec's own pacing table varies how
   * many butts are up and how many are red, never the rank split, and nothing
   * in the brief asks this to tighten with the storm the way those two do.
   *
   * `Math.random() < NEAR_CHANCE` (not `>= NEAR_CHANCE` picking near) is
   * deliberate: the existing wind-up regression tests in
   * tests/range.test.ts pin `Math.random` to exactly 0 and rely on that
   * landing on the near rank (see the "near rank, x = -30" comment there) —
   * this keeps that true for any `NEAR_CHANCE` above 0, so retuning the
   * split does not also have to touch those tests.
   */
  private static readonly NEAR_CHANCE = 0.62;

  /**
   * Raise one butt. `hostileActive` is `attractStep`'s own gate: while it is
   * false (the whole of attract mode) a hostile pick is refused outright,
   * not merely biased against — even on an all-red day, when `up` is empty,
   * attract simply raises nothing rather than a red butt that (per the same
   * gate, read again in `step`) could never be allowed to fire anyway.
   * `wave` is the round's current pacing band (see `waves.ts`): it caps how
   * many reds may already be up, biases the draw toward one more, and picks
   * the behaviour pool a fresh butt may rise with.
   */
  private spawn(hostileActive: boolean, wave: WaveState) {
    if (!this.stocks.length) return;
    const down = this.stocks.filter((x) => x.changePct < 0);
    const up = this.stocks.filter((x) => x.changePct >= 0);
    /*
     * A real market-wide selloff — every tracked ticker down on the day —
     * leaves nothing green to fall back on. This is deliberately distinct
     * from `up.length === 0` used loosely elsewhere: it is checked here,
     * once, and named, rather than left as an implicit consequence of an
     * unfiltered fallback nobody had to reason about.
     */
    const allRedDay = down.length > 0 && up.length === 0;
    /*
     * Half the range should be shooting back — but never past `wave`'s own
     * cap on how many reds may be up at once. `Math.round` rather than
     * `Math.floor`/`Math.ceil`: it is the same rounding `waveAt`'s own doc
     * comment promises and the pacing test asserts, so wave 0's 3 * 0.2
     * lands on the "at most one" the spec states in words, not on zero.
     * `Math.max(1, ...)` only matters once `hostileShare` is high enough
     * that rounding could otherwise floor a real allowance to nothing.
     *
     * On an all-red day that cap is deliberately set aside in favour of
     * `wave.maxUp` itself — every slot the wave allows, not just its
     * hostile share of them. The alternative, holding the normal cap, was
     * considered and rejected: with no green stock anywhere, honouring
     * "at most one red in wave 0" would mean at most one *target* on the
     * whole range, since every remaining ticker is red by definition — a
     * nearly empty wood on exactly the day the game is most topical. A
     * broad selloff is real data, not a bug to paper over, so the range
     * stays full and reads as what it is: today, everything is red. This
     * is the one place `hostileShare`'s own "at most one" promise is
     * knowingly not what ships — tests/range.test.ts covers the normal
     * case live ("the wave 0 hostile cap holds live...") and this
     * deliberate exception separately ("an all-red day bends the wave 0
     * hostile cap on purpose...").
     */
    const activeHostileUp = this._butts.filter((b) => b.dead === 0 && b.hostile).length;
    const hostileCap = allRedDay ? wave.maxUp : Math.max(1, Math.round(wave.maxUp * wave.hostileShare));
    const hostileRoom = activeHostileUp < hostileCap;
    /*
     * Hostility is real: a butt is red because the share is down today. But
     * on a green day that left almost nothing firing, and the game stopped
     * being a game. So the draw is biased above `wave.hostileShare` itself —
     * still a real ticker that really is down, just picked for more often
     * than chance would — and then capped by `hostileRoom` above so the bias
     * cannot push a wave past its own allowance (or, on an all-red day, past
     * the deliberately raised one).
     */
    let pool: Stock[];
    if (!hostileActive) {
      if (!up.length) return;
      pool = up;
    } else {
      const wantHostile =
        hostileRoom && down.length > 0 && (up.length === 0 || Math.random() < wave.hostileShare * 1.4);
      // No `up.length ? up : this.stocks` fallback here any more: `pool`
      // is `down` exactly when `wantHostile` says so, and `wantHostile`
      // already accounts for the all-red day via `hostileCap` above. If
      // `wantHostile` is false there either the cap (raised or not) has
      // been reached — nothing should spawn — or a green stock exists and
      // belongs in `pool` instead.
      if (!wantHostile && !up.length) return;
      pool = wantHostile ? down : up;
    }
    const stock = pool[Math.floor(Math.random() * pool.length)];
    const rank: Rank = Math.random() < World.NEAR_CHANCE ? "near" : "far";
    const x = rand(-30, 30);
    const behaviour = pickBehaviour(wave.wave);
    const butt = makeButt(stock, rank, x, behaviour);
    // stepArrows steers the player's own shots toward whatever carries this
    // flag, and raycasts every arrow's flight against it.
    butt.face.userData.arrowTarget = true;
    this.scene.add(butt.group);
    this._butts.push(butt);
  }

  /**
   * Point the view at a spot on the canvas, 0..1 in each axis.
   *
   * The unlocked fallback. Mapped across the same clamped range that `look`
   * moves through, so both ways of aiming can reach exactly the same places.
   *
   * Not gated on `attracting` the way `look`, `setScoped` and `fire` are. It
   * does not need to be: the menu's transparent overlay covers the whole
   * canvas whenever the card is up, which is the whole of attract mode, so
   * the canvas's own pointer handler never fires and this is unreachable
   * rather than merely harmless. If the overlay's `pointer-events` is ever
   * loosened, gate this too.
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
    // No scope while attracting: raising it would swing the drifting view
    // to wherever the cursor happens to be, which is exactly the kind of
    // input attract mode must not answer.
    if (this.attracting) return;
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
    // The drifting attract camera owns yaw/pitch on its own; a visitor
    // moving the mouse over the menu must not be able to steer it.
    if (this.attracting) return;
    this.aim.set(0, 0);
    const k = this.scoped ? 0.0009 : 0.0022;
    this.turn(-dx * k, -dy * k);
  }

  /**
   * One frame of the round: the clock, hostile spawns and fire, arrow and
   * butt motion, and whatever a hit resolves to — everything `runLoop`
   * drives sixty times a second via `requestAnimationFrame`. Not private:
   * `runLoop` still calls it the same way, but this is also the one thing
   * `tests/range.test.ts`'s acceptance test needs to drive a real round
   * without a real render loop, which needs a browser this test runner does
   * not have. Calling this by hand does not skip anything a frame normally
   * does — it just skips waiting for the browser to schedule it.
   */
  step(dt: number) {
    if (this.over) return;
    const gate = attractStep({ attracting: this.attracting }, dt);
    // The pollen is the one piece of ambient motion `reducedMotion` did not
    // already reach (the release kick and hit recoil were gated on it from
    // the start) — frozen on the same flag rather than only while attracting,
    // since a drifting particle field is exactly the kind of motion that
    // setting exists to stop.
    if (!this.reducedMotion) stepWood(this.wood, dt);
    if (this.hurt > 0) this.hurt = Math.max(0, this.hurt - dt);

    /*
     * Sidestep: a held direction moves at a constant `SIDESTEP_SPEED`
     * toward the clamp, so a full ±3 unit dodge takes exactly
     * `SIDESTEP_MAX / SIDESTEP_SPEED` seconds every time — the number the
     * escape arithmetic is measured against. Releasing eases back to
     * centre instead, on `SIDESTEP_RETURN_EASE`, since the way back is
     * never itself racing a clock the way getting out of the way is.
     */
    if (this.strafeInput !== 0) {
      this.sideOffset = Math.max(
        -SIDESTEP_MAX,
        Math.min(SIDESTEP_MAX, this.sideOffset + this.strafeInput * SIDESTEP_SPEED * dt),
      );
    } else if (this.sideOffset !== 0) {
      this.sideOffset += (0 - this.sideOffset) * Math.min(1, dt * SIDESTEP_RETURN_EASE);
      if (Math.abs(this.sideOffset) < 0.001) this.sideOffset = 0;
    }
    this.camera.position.x = this.sideOffset;

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
    this.msLeft -= gate.clockDt * 1000;
    /*
     * The round's pacing, read fresh every frame from the one pure function
     * that owns it (see `waves.ts`) rather than advanced by hand — during
     * attract mode `gate.clockDt` is 0, so `msLeft` never moves off
     * `ROUND_MS` and this stays at wave 0 the whole time, same as the clock
     * itself not running. Clamped to 0..ROUND_MS before either `waveAt` or
     * the light fraction below reads it, since `msLeft` can sit briefly
     * negative on the very frame the round ends, before the clamp a few
     * lines down catches it for good.
     */
    const elapsedMs = Math.max(0, Math.min(ROUND_MS, ROUND_MS - this.msLeft));
    this.wave = waveAt(elapsedMs);
    /*
     * The light drops a little through the round — a small, deliberate
     * fraction of `LIGHT_DROP` out of the sun's own base intensity, not a
     * second lighting pass. See `LIGHT_DROP`'s own comment for why this
     * stays small.
     */
    this.wood.sun.intensity = this.sunBaseIntensity - (elapsedMs / ROUND_MS) * LIGHT_DROP;
    /*
     * The music tightens for wave 2 — cued once per wave change, not every
     * frame, so `Sfx.setWave` only ever schedules one ramp per transition
     * (see `lastMusicWave`'s own comment).
     */
    if (this.wave.wave !== this.lastMusicWave) {
      this.lastMusicWave = this.wave.wave;
      this.sfx?.setWave?.(this.wave.wave);
    }
    if (this.msLeft <= 0 || this.lives <= 0) {
      this.msLeft = Math.max(0, this.msLeft);
      this.over = true;
      // A fresh idle period starts here — one more real frame renders (the
      // butt still falling, the last flinch settling), and `runLoop` stops
      // rendering after it until the next `start()`.
      this.renderedFinalFrame = false;
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
       * line up the green one that is worth more. The volley itself grows
       * with the wave, same as it always scaled with the round's own
       * progress before waves existed, but is capped so it can never push
       * the range past `wave.maxUp` butts up at once.
       */
      const activeUp = this._butts.filter((b) => b.dead === 0).length;
      const room = Math.max(0, this.wave.maxUp - activeUp);
      if (room > 0) {
        const volley = Math.min(
          room,
          1 + (Math.random() < 0.35 + this.wave.wave * 0.2 ? 1 : 0) + (Math.random() < this.wave.wave * 0.25 ? 1 : 0),
        );
        for (let i = 0; i < volley; i++) this.spawn(gate.hostileActive, this.wave);
      }
      this.spawnIn = rand(this.wave.spawnEvery * 0.75, this.wave.spawnEvery * 1.25);
    }

    for (const b of this._butts) {
      // Captured before `stepButt` mutates `dead`, so a butt that was
      // already falling this frame cannot also loose a shot on the very
      // frame it dies — the same thing the old inline `continue` did.
      const wasFalling = b.dead > 0;
      stepButt(b, dt);
      // The recoil from the hit that killed it plays on top of the fall
      // rather than being skipped for it — a destroyed butt still flinches
      // before it goes over.
      this.stepRock(b, dt);
      if (wasFalling) continue;

      if (b.hostile && b.out > 0.6 && gate.hostileActive) {
        if (b.winding) {
          this.stepWindup(b, dt);
          if (b.windUp >= TELL_MS / 1000) {
            b.winding = false;
            b.windUp = 0;
            this.setTellGlow(b, 0);
            b.cooldown = rand(0.7, 1.3);
            this._arrows.push(looseEnemyArrow(this.scene, b, this.camera.position));
          }
        } else {
          b.cooldown -= dt;
          if (b.cooldown <= 0) {
            b.winding = true;
            b.windUp = 0;
          }
        }
      }
    }
    /*
     * A struck butt falls for its death timer and is then taken out of the
     * scene. Kept as one pass rather than two overlapping filters, which is
     * what this was and which left some of them in the world for ever.
     */
    this._butts = this._butts.filter((b) => {
      if (b.dead >= 0) return true;
      this.scene.remove(b.group);
      disposeButt(b);
      return false;
    });
    // A butt that has fully ducked has done its job and can go.
    this._butts = this._butts.filter((b) => {
      if (b.dead > 0 || b.rising || b.out > 0.01) return true;
      this.scene.remove(b.group);
      disposeButt(b);
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
    stepArrows(this._arrows, dt, this.scene, (a, hit, point) => this.onArrowHit(a, hit, point, gate.consequencesActive));
    this.stepPopups(dt);

    /*
     * The incoming whistle: driven by whichever hostile arrow is nearest
     * the player right now, not a timer started when it was loosed — a shot
     * fired from the far rank has more air to close than one from the near
     * rank, so only the real, changing distance says how urgent it is. Only
     * arrows still actually flying count (`a.stuck === 0`); one that has
     * already landed has nothing left to warn about.
     */
    let nearestHostile = Infinity;
    for (const a of this._arrows) {
      if (a.mine || a.stuck > 0) continue;
      nearestHostile = Math.min(nearestHostile, a.mesh.position.distanceTo(this.camera.position));
    }
    if (nearestHostile < Infinity) this.sfx?.whistle(nearestHostile);
  }

  /**
   * One frame of a hostile butt's wind-up: the rim's glow climbing toward
   * its peak and the whole butt turning to square up on the player, both
   * over the same `TELL_MS` the actual shot waits on — pulled out of `step`
   * only because the block there was already deep enough that a third
   * concern (visuals) inline would have buried the firing decision it sits
   * beside.
   */
  private stepWindup(b: Butt, dt: number) {
    b.windUp = Math.min(TELL_MS / 1000, b.windUp + dt);
    const t = b.windUp / (TELL_MS / 1000);
    this.setTellGlow(b, t);
    const toPlayer = this.camera.position.clone().sub(b.group.position);
    const targetYaw = Math.atan2(toPlayer.x, toPlayer.z);
    b.group.rotation.y += (targetYaw - b.group.rotation.y) * Math.min(1, dt * 6);
  }

  /**
   * The rim's own emissive intensity, from its steady resting glow up to a
   * bright peak at `t = 1` — self-lit, so (per the spec's one rule that
   * cannot bend) it still reads as red at the far rank's 40 units, the same
   * reason `HOSTILE_RIM` is emissive at all rather than a reflective colour
   * riding the warm sun. `t = 0` is also what a shot that just fired resets
   * to, so the glow does not stay at its peak between shots.
   */
  private setTellGlow(b: Butt, t: number) {
    (b.rim.material as T.MeshLambertMaterial).emissiveIntensity = 0.4 + t * 1.4;
  }

  /**
   * Ease a butt's recoil back to upright: 0 right on impact (set in
   * `onArrowHit`), 1 once it has fully settled. Shared by a live butt and a
   * falling (destroyed) one — every credited hit rocks the butt it struck,
   * whether or not that hit goes on to take it down a moment later.
   */
  private stepRock(b: Butt, dt: number) {
    if (b.rock < 1) b.rock = Math.min(1, b.rock + dt / ROCK_TIME);
    const settle = 1 - b.rock;
    // Reduced motion keeps the hit registering (the popup, the marker, the
    // sound) without the 28-degree flinch — this is the one piece of it
    // that was still shaking the world itself rather than a screen overlay.
    const angle = this.reducedMotion ? 0 : ROCK_ANGLE;
    b.group.rotation.x = -angle * settle * settle;
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
   * A small dark rounded chip, sized to its own text, with a thin border in
   * the stock's own colour.
   *
   * The popup used to call `tickerLabel` for this — a whole archery roundel,
   * rings and all, baked into a 256x256 texture several times a second at
   * combo. It was disposed correctly, but it also meant the "ticker chip"
   * the spec describes actually rendered as a miniature second target, with
   * "+123" written over it, flying off the one you had just struck. This
   * draws only what a chip needs: the text, and a panel sized to fit it.
   */
  private chipTexture(text: string, colour: string): { tex: T.Texture; aspect: number } {
    const scale = 3; // supersampled, so the text is crisp at a small on-screen size
    const font = `bold ${15 * scale}px ui-monospace, SFMono-Regular, monospace`;
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = font;
    const textW = measure.measureText(text).width;
    const padX = 12 * scale;
    const padY = 8 * scale;
    const w = Math.ceil(textW + padX * 2);
    const h = Math.ceil(15 * scale + padY * 2);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const c = cv.getContext("2d")!;
    const r = 10 * scale;
    c.beginPath();
    c.moveTo(r, 0);
    c.arcTo(w, 0, w, h, r);
    c.arcTo(w, h, 0, h, r);
    c.arcTo(0, h, 0, 0, r);
    c.arcTo(0, 0, w, 0, r);
    c.closePath();
    c.fillStyle = "rgba(12, 18, 24, 0.82)";
    c.fill();
    c.lineWidth = 2 * scale;
    c.strokeStyle = colour;
    c.stroke();
    c.fillStyle = "#f8f4e6";
    c.font = font;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, w / 2, h / 2 + scale);
    const tex = new T.CanvasTexture(cv);
    tex.colorSpace = T.SRGBColorSpace;
    return { tex, aspect: w / h };
  }

  /**
   * The points chip that pops off a struck face: a sprite showing the
   * ticker and the points just earned, on a short upward path that fades.
   */
  private spawnPopup(b: Butt, gained: number, colour: string) {
    const { tex, aspect } = this.chipTexture(`${b.stock.symbol} +${gained}`, colour);
    // Left to occlude normally: a chip this small has no reason to draw
    // through the trees and terrain the way the old roundel-sized popup did.
    const mat = new T.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new T.Sprite(mat);
    sprite.scale.set(POPUP_SCALE * aspect, POPUP_SCALE, 1);
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
  private onArrowHit(a: Arrow, hit: T.Object3D, point: T.Vector3 | undefined, consequencesActive: boolean) {
    // `attractStep`'s own gate, consulted here rather than re-derived: no
    // credited hit may change points or health while attracting. In
    // practice no arrow should exist to reach this at all — input refuses
    // to fire and a hostile butt cannot spawn or loose one — but this is
    // the one place score and health actually move, so it holds the line
    // even if an arrow got here some other way.
    if (!consequencesActive) return;
    if (a.mine) {
      const b = this._butts.find((x) => x.face === hit);
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
      // The far rank's face is drawn at half size (`makeButt`) — scoring it
      // against the unscaled `FACE_RADIUS` would judge a hit against a
      // roundel bigger than the one actually on screen, so the same
      // `faceScale` that shrank the geometry shrinks the ring boundaries
      // here too.
      const ring = ringOf(distanceFromCentre, FACE_RADIUS * RANKS[b.rank].faceScale);

      const move = Math.abs(b.stock.changePct);
      const basePoints = Math.round(40 + move * 60);
      const result = resolveButtHit({
        hostile: b.hostile,
        ring,
        basePoints,
        comboBefore: this.combo,
        streakBefore: this.streak,
        bestRingBefore: this.bestRing,
        // On top of the existing ring multiplier, not instead of it — a far
        // hit already had to be smaller to land; this is what makes it also
        // worth double.
        rankBonus: RANKS[b.rank].bonus,
      });

      this.hits += 1;
      this.combo = result.combo;
      this.streak = result.streak;
      this.bestRing = result.bestRing;
      this.mark += 1;
      this.markKill = b.hostile;
      // The gold ring gets the same brighter marker a kill does — both mean
      // "that was a good one".
      this.sfx?.marker(b.hostile || ring === 1);
      this.points += result.gained;

      // "The ticker that earned the most" this round — the running total per
      // symbol, not whichever one happened to hand back the single biggest
      // hit. A share card naming a lucky one-off gold instead of the ticker
      // that actually paid the most over the round would be a wrong answer,
      // not just a different one.
      const best = bestSymbolAfter(
        this.symbolPoints,
        { bestSymbol: this.bestSymbol, bestSymbolPoints: this.bestSymbolPoints },
        b.stock.symbol,
        result.gained,
      );
      this.bestSymbol = best.bestSymbol;
      this.bestSymbolPoints = best.bestSymbolPoints;

      this.spawnPopup(b, result.gained, ringColourFor(b.hostile));

      // Every credited hit destroys its target, green or red alike — a
      // standing butt left alive after being scored is exactly the exploit
      // `resolveButtHit`'s `destroyButt` field exists to prevent (see
      // butts.ts). It still rocks on the way down: `stepRock` runs for a
      // falling butt too. `applyButtHit` is the same function this file's
      // tests exercise directly against the real `isTargetable`, so this
      // call site and the test cannot silently drift apart the way the
      // inline version once did.
      applyButtHit(b, result);
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
    if (this.over || this.attracting || this.drawing || !nockReady(this.drawn)) return;
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
   * would otherwise give you. Gated on the same full nock `fire` itself now
   * insists on, explicitly and not just by inheriting it — this is exactly
   * the path that used to walk past `beginDraw`'s stricter gate and loose
   * through `fire`'s old, looser one.
   */
  touchFire(): boolean {
    if (this.attracting || !nockReady(this.drawn)) return false;
    return this.fire(TOUCH_DRAW, true);
  }

  /**
   * Loose an arrow down the centre of the view, at `draw` strength.
   *
   * The single place a shot is actually loosed — `releaseDraw` and
   * `touchFire` both end up here rather than each flying their own arrow.
   */
  fire(draw = 1, touch = false, heldSeconds = 0): boolean {
    if (this.over || this.attracting) return false;
    /*
     * One arrow at a time.
     *
     * A longbow is not a machine gun, and without this the honest answer to
     * every target is to click as fast as the mouse allows. Making you wait
     * for the nock is what turns aiming into a decision. The gate is a full
     * nock (`nockReady`), the same one `beginDraw` uses — it used to be a
     * half-nock door of its own (`drawn < 0.5`), which `touchFire` reached by
     * calling straight in past `beginDraw`, firing a tapping phone every
     * 210ms against a mouse's ~525ms. Nothing legitimate needs the looser
     * door: a mouse always clears a full nock anyway on its way to a real
     * pull, so raising this to match cost it nothing.
     */
    if (!nockReady(this.drawn)) return false;
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
    this._arrows.push({ mesh, vel, life: ARROW_LIFE, mine: true, stuck: 0, spin: rand(2, 5), touch });
    return true;
  }

  /**
   * `World` no longer holds a canvas to measure itself — `page.tsx` does,
   * and passes the CSS box it just gave the canvas straight through. The
   * defaults are only for a `World` nobody has resized yet (a fresh one in
   * a test, say): the same 960×560 fallback the old canvas-reading version
   * fell back to before its first real layout.
   *
   * A default parameter alone only catches `undefined` — the old code read
   * `canvas.clientWidth || 960`, which also caught `0` (a real value a
   * layout-less canvas actually reports). `||` here restores that: a zero
   * or missing dimension both mean "no real size yet", not "a zero-sized
   * stage" — do not tidy this back to a bare default, it would silently let
   * `camera.aspect` and `surface.setSize` see a `0`/`NaN` again.
   */
  resize(w?: number, h?: number) {
    w ||= 960;
    h ||= 560;
    this.surface.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    /*
     * The 2048² shadow map costs the same second render pass whatever the
     * canvas ends up drawn at — full price on a narrow phone screen just as
     * much as on a 1220px desktop stage. Below SHADOW_DROP_WIDTH the map
     * halves to 1024², which three.js will not pick up on its own: the
     * shadow render target is allocated once and cached on `shadow.map`, so
     * changing `mapSize` after that point does nothing until the stale
     * target is freed and cleared here, letting it be rebuilt at the new
     * size the next time a shadow pass runs.
     */
    const wantSize = w < SHADOW_DROP_WIDTH ? 1024 : 2048;
    const shadow = this.wood.sun.shadow;
    if (shadow.mapSize.width !== wantSize) {
      shadow.mapSize.set(wantSize, wantSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
  }

  /**
   * The camera's own motion while attracting: a slow, looping pan into the
   * middle distance rather than the fixed forward stare a stopped camera
   * would give the menu. Written directly into `yaw`/`pitch` rather than
   * through `turn()`'s deltas, and kept well inside the same clamp `turn()`
   * enforces during play (±0.85 yaw, -0.32..0.28 pitch) — so it can never
   * fight that clamp, it just never needs to ask it for anything.
   *
   * Off entirely under reduced motion, the same way the release kick and the
   * hit recoil already were — a camera continuously panning under a menu is
   * close to the worst case for the people that setting exists for, and this
   * phase is exactly where the drift was introduced.
   */
  private driftCamera(dt: number) {
    if (!this.attracting || this.reducedMotion) return;
    this.attractT += dt;
    const YAW_PERIOD = 26; // seconds for a full left-right-left sweep
    const PITCH_PERIOD = YAW_PERIOD * 1.7; // out of phase with the yaw, so the two never simply mirror each other
    this.yaw = Math.sin((this.attractT / YAW_PERIOD) * Math.PI * 2) * 0.6;
    // Levelled toward the middle distance — a shade below dead level, not
    // up at the sky or down at the ground — with a gentle rise and fall on
    // top of it.
    this.pitch = -0.04 + Math.sin((this.attractT / PITCH_PERIOD) * Math.PI * 2) * 0.05;
  }

  /**
   * Start the render loop, if it is not already running. Shared by
   * `attract()` and `start()` — both just decide the mode first — so a
   * `start()` that finds the loop already going (leaving attract, or
   * replaying after a round ended) does not spin up a second one racing it
   * for the same canvas.
   */
  private runLoop() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    let since = 0;
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.driftCamera(dt);

      // Ease the field of view rather than snapping it: a scope that changes
      // magnification instantly reads as a glitch. Drawing narrows it too, a
      // little — the world closing in as the shot comes together.
      const want = this.scoped ? FOV_SCOPE : FOV_WIDE - this.draw * DRAW_FOV_NARROW;
      this.camera.fov += (want - this.camera.fov) * Math.min(1, dt * 9);
      this.camera.updateProjectionMatrix();
      // The release kick rides on top of the aimed pitch rather than changing
      // it, so it settles back to exactly where you were looking rather than
      // leaving the view drifted. Reduced motion zeroes the kick itself
      // rather than skipping this line — `kick` still decays normally, so a
      // shot still visibly registers through the sound and the bow's own
      // recoil, it just does not shake the camera to say so.
      const releaseKick = this.reducedMotion ? 0 : RELEASE_KICK;
      this.camera.rotation.set(this.pitch - this.kick * releaseKick, this.yaw, 0, "YXZ");

      // Once a round is over and nothing is attracting, `step` and
      // `driftCamera` above both returned without changing a single thing —
      // so render exactly one more frame (the butt still falling, the last
      // flinch settling) and then stop spending a shadow pass on an image
      // that will not change again until the next `start()`.
      const idle = this.over && !this.attracting;
      if (!idle || !this.renderedFinalFrame) {
        this.surface.render(this.scene, this.camera);
        if (idle) this.renderedFinalFrame = true;
      }
      since += dt;
      // The snapshot is entirely constant while attracting (see `attract()`,
      // which already pushes the one snapshot that state ever needs) — no
      // reason to re-render the card, the chips and the board ten times a
      // second for however long a visitor leaves the menu open.
      if (since >= 0.1 && !this.over && !this.attracting) {
        since = 0;
        this.onChange(this.snapshot());
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * Pause or resume the render loop without tearing anything down — used by
   * an `IntersectionObserver` on the stage (see page.tsx) so a visitor who
   * has scrolled the canvas out of view, or a menu left open behind another
   * tab on a phone, is not paying for a full render and a shadow pass on
   * pixels nobody can see. `runLoop` is idempotent, so bringing the stage
   * back into view can simply call it again; `stop()` remains the one real
   * teardown, called only on unmount.
   */
  setActive(active: boolean) {
    if (active) {
      this.runLoop();
      return;
    }
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /**
   * Run the world with nothing at stake: the wood lit and moving, butts
   * rising and settling, the camera drifting on its own — and, via
   * `attracting`, every input that could shoot or score refusing outright
   * (see `look`, `fire`, `beginDraw`, `touchFire`, `setScoped`) and `step`
   * itself skipping the clock, hostile spawns and fire, and any hit's
   * consequences (see `attractStep`). This is what runs from the moment the
   * page mounts, so the range is alive under the menu rather than a black
   * box waiting for Start.
   */
  attract() {
    this.attracting = true;
    this.attractT = 0;
    this.onChange(this.snapshot());
    this.runLoop();
  }

  /**
   * Leave attract mode — a no-op if it was not running — and begin a real
   * round: every bit of state a round accumulates is reset, but the wood,
   * the bow and the renderer are the one built at construction and carry on
   * unchanged, so pressing Start does not so much as flicker the view.
   */
  start() {
    this.attracting = false;
    this.scoped = false;
    this.clearRound();
    this.points = 0;
    this.health = 100;
    this.lives = START_LIVES;
    this.hits = 0;
    this.shots = 0;
    this.combo = 0;
    this.streak = 0;
    this.bestRing = 0;
    this.bestSymbol = "";
    this.symbolPoints.clear();
    this.bestSymbolPoints = 0;
    this.msLeft = ROUND_MS;
    this.over = false;
    this.hurt = 0;
    this.mark = 0;
    this.markKill = false;
    this.wave = waveAt(0);
    this.wood.sun.intensity = this.sunBaseIntensity;
    this.lastMusicWave = -1;
    this.drawn = 1;
    this.draw = 0;
    this.drawing = false;
    this.heldSeconds = 0;
    this.kick = 0;
    this.spawnIn = 0.5;
    this.yaw = 0;
    this.pitch = 0;
    this.strafeInput = 0;
    this.sideOffset = 0;
    this.camera.position.x = 0;
    this.onChange(this.snapshot());
    this.runLoop();
  }

  /**
   * Free every arrow, butt and popup a round (or attract mode) built up —
   * shared by `start()`, which clears whatever attract mode or the last
   * round left standing before a new one begins, and `stop()`'s final
   * teardown, so the two disposal passes cannot quietly drift apart the way
   * `disposeButt`'s own history warns against.
   */
  private clearRound() {
    // Whatever popups had not finished fading do not get another frame to
    // do so — free their textures now rather than leaking them.
    for (const p of this.popups) this.disposePopup(p);
    this.popups = [];
    for (const a of this._arrows) {
      this.scene.remove(a.mesh);
      a.mesh.geometry.dispose();
      (Array.isArray(a.mesh.material) ? a.mesh.material : [a.mesh.material]).forEach((m) => m.dispose());
    }
    this._arrows = [];
    for (const b of this._butts) {
      this.scene.remove(b.group);
      disposeButt(b);
    }
    this._butts = [];
  }

  /**
   * Free everything this world built, wood included. Only called on
   * unmount now that one `World` carries on from attract through however
   * many rounds are played, rather than a fresh one being built per round —
   * `renderer.dispose()` frees the WebGL context; it does not touch a
   * single geometry or texture drawn through it.
   */
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.clearRound();
    disposeWood(this.wood);
    this.surface.dispose();
  }
}
