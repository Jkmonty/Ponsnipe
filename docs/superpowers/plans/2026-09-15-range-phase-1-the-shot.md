# Range Phase 1: The Shot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the arrow a thing that flies and the bow a thing you draw, so a shot is a decision rather than a click.

**Architecture:** `src/app/(site)/range/world.ts` (1,012 lines) splits by responsibility into `scene.ts`, `butts.ts` and `arrows.ts`, each exporting plain functions over data they are handed; `World` keeps the camera, the loop and the score. Then hitscan shooting is replaced by real projectiles, the draw is added on desktop with tap-to-fire on touch, and hits get a reaction worth seeing.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, three.js 0.186 (already a dependency, loaded only on this route), plain CSS. Tests run with `node --import tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-15-range-rebuild-design.md` — read it; this plan implements its "The shot" section plus the file split, and nothing else.

## Global Constraints

- Node `>=22.5.0`. Next `^16.3.4`. **Add no dependencies**; three.js is already present.
- **This is not the Next.js you know.** Read any needed guide under `node_modules/next/dist/docs/01-app/` before writing Next-specific code. This phase is almost all three.js and touches one React file.
- Nothing outside `src/app/(site)/range/` changes, except the two new test files under `tests/`.
- The board, `/api/arcade`, the score payload and the weekly reset are untouched. A score posted by the new game is the same row as before.
- Comments explain **why**, in plain prose, matching the voice already in these files. Keep every existing comment when moving code.
- Round shape is unchanged: `ROUND_MS` 60,000 ms, `START_LIVES` 3, 18 health per arrow taken.
- Phase 1 adds exactly three fields to `Snapshot`: `draw`, `streak`, `bestRing`, and `bestSymbol`. **`wave` is Phase 3 and must not appear yet.** (That is four field names; `draw` belongs to Task 3, the other three to Task 4.)
- Dev servers start ONLY through the Browser tools, never Bash. `.claude/launch.json` has `ponsnipe` (full app) and `ponsnipe-public` (PUBLIC_MODE=1); only one may run at a time. The range is at `/range` on either.
- The game's own console handle `window.__arcade` is the sanctioned way to drive a round in a headless check: it is the live `World`. Use it rather than waiting 60 real seconds.
- If `npm run typecheck` fails only on generated files under `.next/types` or `.next/dev/types`, run `npx next typegen` once and re-run.
- Do not commit `.claude/launch.json`, anything under `.superpowers/`, `.env`, or anything under `.next`.
- Commit messages: a short plain sentence saying what changed and why, then the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Quote paths containing parentheses in git commands.

---

## File map

| Path | Responsibility |
|---|---|
| `src/app/(site)/range/scene.ts` | Builds the static wood and returns its pieces |
| `src/app/(site)/range/butts.ts` | Target type, spawning, per-frame behaviour, scoring maths |
| `src/app/(site)/range/arrows.ts` | Everything in flight, yours and theirs, plus the draw curve and magnetism |
| `src/app/(site)/range/world.ts` | Camera, loop, score, snapshot, bow rig, input |
| `src/app/(site)/range/page.tsx` | Adds the draw meter to the HUD; pointer handling for hold and tap |
| `tests/range.test.ts` | Draw curve, magnetism angle, ring multipliers, combo and streak |

---

### Task 1: Split `world.ts` by responsibility

A pure refactor. **No behaviour changes at all** — the game must play exactly as it does now when this task is done.

**Files:**
- Create: `src/app/(site)/range/scene.ts`
- Create: `src/app/(site)/range/butts.ts`
- Create: `src/app/(site)/range/arrows.ts`
- Modify: `src/app/(site)/range/world.ts`

**Interfaces:**
- Produces:
  - `scene.ts`: `export interface Wood { root: T.Group; sun: T.DirectionalLight }` and `export function buildWood(scene: T.Scene): Wood`
  - `butts.ts`: `export interface Butt {...}` (moved verbatim), `export const LANES`, `export const HIT_RADIUS`, `export function tickerLabel(text: string, colour: string): T.Texture`, `export function makeButt(stock: Stock, lane: number, x: number): Butt`
  - `arrows.ts`: `export interface Arrow {...}` (moved verbatim), `export function makeArrowMesh(): T.Mesh`
  - `world.ts`: unchanged public surface — `World`, `ROUND_MS`, `Snapshot`, `Stock`

- [ ] **Step 1: Read the file end to end**

Read `src/app/(site)/range/world.ts` completely before moving anything. The methods to move are `buildWorld` (172), `oak` (230), `tower` (260), `palisade` (402), `bale` (416), `pennant` (427), `campfire` (443), `hedge` (464), `tree` (476), `rock` (500) into `scene.ts`; `label` (527), `spawn` (559) and the `Butt` interface, `LANES`, `HIT_RADIUS` into `butts.ts`; `makeArrow` (392), `loose` (869) and the `Arrow` interface into `arrows.ts`.

`buildBow` (290) and `roughBow` (376) **stay** in `world.ts`: the bow is the first-person rig, tied to the camera, not scenery.

- [ ] **Step 2: Create `scene.ts`**

Move the ten scenery methods verbatim, every comment with them, converting each from a private method to a module function that takes what it needs. `buildWorld` becomes:

```ts
/**
 * The wood, built once.
 *
 * Everything here is primitive geometry generated in code: cones, cylinders,
 * jittered icosahedra. That is not a shortcut, it is the art style — the
 * low-poly games this is modelled on are boxes and cones with flat shading
 * and a warm sky, and none of it is sculpted. So there are no asset files to
 * load and the whole wood is built in a few milliseconds.
 */
export function buildWood(scene: T.Scene): Wood {
  // …the body of the old buildWorld, with `this.scene` → `scene` and
  // `this.oak(x, z)` → `oak(x, z)`, and the sun light returned rather than
  // dropped…
}
```

Keep `rand` in whichever module uses it; if more than one does, export it from `scene.ts` and import it.

- [ ] **Step 3: Create `butts.ts` and `arrows.ts`**

Same treatment. `spawn()` reads `this.stocks`, `this.butts` and `this.scene`, so it becomes `makeButt(stock, lane, x)` returning a `Butt` the caller adds; the *decision* of how many to raise and where stays in `world.ts` for now (Phase 3 moves it). `loose(b)` becomes `looseEnemyArrow(scene, b, at: T.Vector3): Arrow`.

- [ ] **Step 4: Slim `world.ts`**

Import from the three new modules and delete the moved methods. `world.ts` keeps: the class, `Snapshot`, `Stock`, `ROUND_MS`, the bow rig, input (`aimAt`, `look`, `turn`, `setScoped`, `aimFromCursor`), `step`, `fire`, `resize`, `start`, `stop`.

- [ ] **Step 5: Typecheck and the suite**

Run: `npm run typecheck && npm test`
Expected: clean; 165 passing.

- [ ] **Step 6: Play a round and prove nothing changed**

Start `ponsnipe-public` through the Browser tools, open `/range`, resize the pane to 1280×800, press Start, and play. Then drive the end from the console so you do not wait a minute:

```js
const g = window.__arcade;
g.fire(); // a few times, moving the pointer between shots
g.msLeft = 300;
```

Expected: targets rise, shots register, the HUD counts, the round ends, a score posts or says a wallet is needed, and the board updates. The console is free of errors other than the known `/api/img` 404s from the feed.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(site)/range"
git commit -m "The range splits into scenery, targets and arrows" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The arrow flies

**Files:**
- Modify: `src/app/(site)/range/arrows.ts`
- Modify: `src/app/(site)/range/world.ts`
- Test: `tests/range.test.ts`

**Interfaces:**
- Consumes: `Arrow`, `makeArrowMesh` from Task 1.
- Produces, all from `arrows.ts`:
  - `export const DRAW_MIN_SPEED = 28; export const DRAW_MAX_SPEED = 55; export const GRAVITY = 9.8;`
  - `export function drawSpeed(draw: number): number` — `draw` clamped to 0..1, linear between the two speeds.
  - `export function assistAngle(touch: boolean): number` — 0.0384 radians (2.2°) for mouse, 1.5× for touch.
  - `export function steerToward(dir: T.Vector3, to: T.Vector3, maxAngle: number, dt: number): void` — nudges `dir` toward `to` if within `maxAngle`.
  - `export function stepArrows(arrows: Arrow[], dt: number, scene: T.Scene, onHit: (a: Arrow, hit: T.Object3D) => void): void`
  - `Arrow` gains `mine: boolean`, `stuck: number` (seconds stuck, or 0 while flying) and `spin: number`.

- [ ] **Step 1: Write the failing tests**

Create `tests/range.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { drawSpeed, assistAngle, DRAW_MIN_SPEED, DRAW_MAX_SPEED } from "../src/app/(site)/range/arrows";

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
  // Small enough that a bad shot still misses: under three degrees.
  assert.ok(touch < 0.0524, "assist must stay under 3 degrees");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test tests/range.test.ts`
Expected: FAIL, cannot find module `../src/app/(site)/range/arrows` exports.

- [ ] **Step 3: Write the flight**

In `arrows.ts`:

```ts
/** A full draw sends it flat and fast; a snap shot lobs. */
export const DRAW_MIN_SPEED = 28;
export const DRAW_MAX_SPEED = 55;
export const GRAVITY = 9.8;

export function drawSpeed(draw: number): number {
  const d = Math.max(0, Math.min(1, draw));
  return DRAW_MIN_SPEED + (DRAW_MAX_SPEED - DRAW_MIN_SPEED) * d;
}

/**
 * How far off a shot may be and still be helped home.
 *
 * The old hitscan snapped any miss inside 2.6 degrees onto the target, which
 * is what stopped the game reading as broken. A flying arrow cannot snap, so
 * it steers instead — the same forgiveness, spent over the flight. A thumb is
 * not a mouse, so touch gets half as much again.
 */
export function assistAngle(touch: boolean): number {
  const base = 0.0384; // 2.2 degrees
  return touch ? base * 1.5 : base;
}
```

`stepArrows` integrates each arrow: apply gravity to `vel`, steer if `mine` and a target is near the path, move by `vel * dt`, spin the mesh about its own axis, and raycast the segment just travelled against the butt faces and the ground. On a hit, call `onHit`, set `stuck` and stop moving it. Stuck arrows fade over three seconds and are removed; at most 24 live at once, oldest first.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/range.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Loose a real arrow from `fire()`**

In `world.ts`, `fire()` stops raycasting for the hit and instead spawns an arrow from the bow's position along the aim direction at `drawSpeed(this.draw)`. The scoring that used to happen in `fire()` moves into the `onHit` callback passed to `stepArrows`. Keep the matrix-update comment and the reasoning above it: it is still true, because the direction is still read from the camera.

- [ ] **Step 6: Typecheck, suite, and shoot something**

Run: `npm run typecheck && npm test`
Expected: clean; 169 passing.

In the browser on `/range`: shots now visibly fly, arc, and stick. A close butt is easy; a far one needs aiming slightly high. Console clean.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(site)/range" tests/range.test.ts
git commit -m "The arrow leaves the bow and flies, instead of arriving already there" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Draw and release

**Files:**
- Modify: `src/app/(site)/range/world.ts`
- Modify: `src/app/(site)/range/page.tsx`
- Modify: `src/app/(site)/site.css` — the draw meter's rules go here, scoped under `.site` like every other rule in that file. The range's existing `.arc-*` rules live in `src/app/globals.css`, which belongs to the terminal and **must not be touched**.
- Test: `tests/range.test.ts` (extend)

**Interfaces:**
- Consumes: `drawSpeed` from Task 2.
- Produces:
  - `World` gains `beginDraw()`, `releaseDraw()`, and `touchFire()`; `fire()` stays as the immediate shot both of those end up calling.
  - `Snapshot` gains `draw: number` (0..1).
  - `arrows.ts` gains `export function drawShake(heldSeconds: number): number` — 0 until 1.4 s, then rising to a maximum of 0.0175 radians (1°) at 3 s.

- [ ] **Step 1: Write the failing test**

Append to `tests/range.test.ts`:

```ts
import { drawShake } from "../src/app/(site)/range/arrows";

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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test tests/range.test.ts`
Expected: FAIL on `drawShake` not being exported.

- [ ] **Step 3: Implement the draw**

`drawShake` in `arrows.ts`:

```ts
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
```

In `world.ts`: `draw` runs 0 → 1 over 700 ms while held. `beginDraw()` starts it and only if the nock is full; `releaseDraw()` looses when `draw >= 0.15`, otherwise abandons and resets. The bow bends with `draw`, the field of view narrows by 4°, and `sfx.creak?.(draw)` is called as it rises. On release the camera kicks 0.9° and settles over 200 ms; the nock refills over 420 ms. `touchFire()` looses immediately at `draw = 0.8`.

- [ ] **Step 4: Wire the input in `page.tsx`**

`onPointerDown` with `e.button === 0`: on a mouse, `beginDraw()`; on touch (`e.pointerType === "touch"`), `touchFire()`. `onPointerUp` with `e.button === 0` on a mouse: `releaseDraw()`. `onPointerLeave` abandons the draw. The right button keeps doing the scope exactly as now.

Add a draw meter to the HUD: a thin lime bar that fills with `s.draw`, shown only while drawing, with the classes `.arc-draw` and its inner `i`, and rules for them in `src/app/(site)/site.css` beside the other range rules.

- [ ] **Step 5: Typecheck, suite, and draw a bow**

Run: `npm run typecheck && npm test`
Expected: clean; 171 passing.

In the browser: holding the left button bends the bow and fills the meter; releasing looses; a snapped shot lobs short and a full one flies flat. At phone size, a tap fires. Console clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(site)" tests/range.test.ts
git commit -m "Hold to draw, release to loose, and one tap on a phone" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: A hit worth seeing

**Files:**
- Modify: `src/app/(site)/range/butts.ts`
- Modify: `src/app/(site)/range/world.ts`
- Modify: `src/app/(site)/range/page.tsx`
- Modify: `src/app/(site)/site.css`
- Test: `tests/range.test.ts` (extend)

**Interfaces:**
- Produces, from `butts.ts`:
  - `export function ringOf(distanceFromCentre: number, faceRadius: number): number` — 1 gold, 2 red, 3 blue, 4 black, 5 white, by the face's own proportions.
  - `export function ringMultiplier(ring: number): number` — 3, 2, 1.5, 1, 1.
  - `export function comboAfter(hit: boolean, combo: number): number`
  - `export function streakAfter(hit: boolean, combo: number, best: number): number`
  - `Snapshot` gains `streak: number`, `bestRing: number`, `bestSymbol: string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/range.test.ts`:

```ts
import { ringOf, ringMultiplier, comboAfter, streakAfter } from "../src/app/(site)/range/butts";

test("the rings run gold, red, blue, black, white from the centre out", () => {
  const r = 10;
  assert.equal(ringOf(0, r), 1);
  assert.equal(ringOf(1.5, r), 2);
  assert.equal(ringOf(4, r), 3);
  assert.equal(ringOf(6.5, r), 4);
  assert.equal(ringOf(9, r), 5);
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --test tests/range.test.ts`
Expected: FAIL on the four missing exports.

- [ ] **Step 3: Implement the scoring**

Rings are proportions of the face radius, matching the drawn target: gold inside 0.1, red to 0.3, blue to 0.5, black to 0.7, white beyond. `comboAfter` returns `hit ? combo + 1 : 0`. `streakAfter` returns `Math.max(best, hit ? combo + 1 : combo)`.

- [ ] **Step 4: Make the hit land**

In `onHit`: the butt rocks back on its post and settles over 400 ms; the ticker chip pops off the face and floats up showing the points earned, fading over 900 ms; `bestRing` keeps the best ring struck; `bestSymbol` keeps the ticker that earned most. A red butt struck is destroyed and stops shooting, as now. The gold ring gets the brighter marker through the existing `sfx.marker(true)`.

- [ ] **Step 5: Show the combo**

In `page.tsx`, the combo counter already exists in the HUD; make it grow and fade on each increment, and add the streak to nothing yet — it is carried in the snapshot for Phase 3's results card and is not displayed this phase.

- [ ] **Step 6: Typecheck, suite, and hit some targets**

Run: `npm run typecheck && npm test`
Expected: clean; 175 passing.

In the browser: a hit rocks the butt and pops the ticker; a centre hit scores triple and ticks brighter; the combo climbs and resets on a miss. Console clean.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(site)" tests/range.test.ts
git commit -m "A hit rocks the butt, pops the ticker, and pays for the gold" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

- **File split by responsibility:** Task 1. `share.ts` is Phase 3 and absent here, correctly.
- **Projectile arrows, gravity, speeds, one integrator for both sides:** Task 2.
- **Stuck arrows fading, 24 at once:** Task 2, step 3.
- **Magnetism as steering, 2.2°, 1.5× on touch:** Task 2.
- **Draw 0→1 over 700 ms, 0.15 floor, 4° field of view, creak, shake past 1.4 s, 0.9° kick, 420 ms nock:** Task 3.
- **Tap to fire at 0.8 on touch:** Task 3, steps 3 and 4.
- **Butt rocks, ticker pops, combo, rings 3/2/1.5/1/1, gold brighter:** Task 4.
- **Snapshot gains exactly `draw`, `streak`, `bestRing`, `bestSymbol`:** Tasks 3 and 4. `wave` correctly deferred.
- **Tests: draw curve, assist angle, ring multipliers, combo and streak:** Tasks 2, 3, 4. The wave schedule and share layout belong to later phases.
- **Not in this phase, by design:** two ranks, behaviours, telegraphed incoming arrows, sidestep, waves, attract mode, the menu card, golden hour, slow motion, results card, share image. Those are Phases 2 and 3.
