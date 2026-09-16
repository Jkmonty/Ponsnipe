# Range Phase 3: Danger and the Ending — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the range a game you can lose to and want to post about — targets that behave, reds that telegraph before they shoot, a round that builds, and an ending worth sharing.

**Architecture:** The phase opens by making `World` constructible without a browser, which is the thing that has blocked three rounds of tests from covering wiring rather than arithmetic. The per-frame target behaviour moves to `butts.ts` where it belongs and becomes testable. Then the game gains two ranks and four behaviours, telegraphed hostile fire with sidestepping, a three-wave pacing curve, and an ending: slow motion, a results card, and a share image drawn in the browser.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, three.js 0.186 (already present, route-only), Web Audio through `sfx.ts`, Canvas 2D for the share image, plain CSS.

**Spec:** `docs/superpowers/specs/2026-09-15-range-rebuild-design.md` — read it. This plan implements its "Targets and danger", "The ending" and the remaining half of "The shot" sections. Phases 1 and 2 are merged and live.

## Global Constraints

- Node `>=22.5.0`. **Add no dependencies.**
- Nothing outside `src/app/(site)/range/`, `src/app/(site)/site.css`, `public/arcade/` and `tests/` changes. **`src/app/globals.css` belongs to the trading terminal and must not be touched**; override from `site.css` with specificity.
- three.js must not leak outside `src/app/(site)/range/`.
- Round shape stays 60 seconds and three arrows taken. The `/api/arcade` score payload is unchanged — the results card and the share image are read-only views of a round that already happened.
- **Say what the code does.** Three times in Phase 2, prose contradicted the code beside it: a report claiming trees cast shadows when they did not, a test comment claiming coverage it structurally could not have, and a module summary describing wiring deleted in the same commit. Each was written by someone who had just read the correct code, and each was caught by review rather than by a test. **Every comment or report sentence describing behaviour is checked against the printed diff before it is written**, and reviewers treat a stale comment as an Important finding, not a Minor one.
- **No sound, field or flag without a caller.** Phase 1 shipped two things set and never read. The `whistle` lands in this phase because Task 3 gives it a caller, and not before.
- Assets: **CC0 or CC-BY only, never non-commercial**, recorded in `public/arcade/CREDITS.md` with author, licence and source. The range's assets stay under 6 MB.
- Dev servers start ONLY through the Browser tools, never Bash. `.claude/launch.json` has `ponsnipe` and `ponsnipe-public`; one at a time; either serves `/range`.
- **The Browser pane throttles `requestAnimationFrame` when it is not painting.** A check that watches a clock and sees nothing change has proved nothing — that has caught people out three times here. Drive the loop by hand with `window.__arcade` and `g.step(1/60)`. **From Task 1 onward there is a better option: construct a headless `World` in a node test and step it.** Prefer that.
- If `npm run typecheck` fails only on generated files under `.next/types` or `.next/dev/types`, run `npx next typegen` once and re-run.
- Do not commit `.claude/launch.json`, anything under `.superpowers/`, `.env`, or anything under `.next`.
- Commit messages: a short plain sentence saying what changed and why, then the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Quote paths containing parentheses.

---

## File map

| Path | Responsibility |
|---|---|
| `src/app/(site)/range/render.ts` | The renderer seam: a tiny interface plus the real and null implementations |
| `src/app/(site)/range/butts.ts` | Gains per-frame behaviour, the two ranks, and the four behaviours |
| `src/app/(site)/range/waves.ts` | The pacing schedule, as a pure function of elapsed time |
| `src/app/(site)/range/share.ts` | The results image, drawn on a canvas |
| `src/app/(site)/range/world.ts` | Loses the butt loop; gains sidestep, slow motion, telegraphed fire |
| `src/app/(site)/range/page.tsx` | Movement keys, the results card, the share button |
| `src/app/(site)/range/sfx.ts` | `whistle`, and the wave-two music tightening |
| `tests/range.test.ts` | The headless acceptance test, behaviours, waves, share layout |

---

### Task 1: A `World` that needs no browser

The phase's foundation, and the item three earlier rounds were deferred against. A pure refactor plus one new test: **no gameplay changes at all.**

**Files:**
- Create: `src/app/(site)/range/render.ts`
- Modify: `src/app/(site)/range/world.ts`, `butts.ts`, `page.tsx`
- Test: `tests/range.test.ts`

**Interfaces:**
- `render.ts`: `export interface Surface { setSize(w: number, h: number): void; setPixelRatio(r: number): void; render(scene: T.Scene, camera: T.Camera): void; dispose(): void; readonly shadows: { enabled: boolean; mapSize: number }; }`, plus `makeSurface(canvas: HTMLCanvasElement): Surface` and `makeNullSurface(): Surface`.
- `World`'s constructor takes a `Surface` rather than a canvas.
- `butts.ts`: `export function stepButt(b: Butt, dt: number, bounds?: number): void` — the per-frame motion currently inline in `world.ts`.

- [ ] **Step 1: The seam**

`render.ts` wraps `T.WebGLRenderer` behind `Surface`. `makeNullSurface()` returns an implementation that records the last size and does nothing else — no WebGL, no canvas, no DOM. Keep the tone-mapping and shadow settings inside `makeSurface`, so the null one cannot diverge on them.

- [ ] **Step 2: `World` takes a `Surface`**

Change the constructor. `page.tsx` calls `makeSurface(canvas)` inside its existing try/catch — **the WebGL fallback from Phase 2 must keep working**, so the throw stays inside `makeSurface` and the catch stays where it is.

- [ ] **Step 3: Move the butt loop**

Lift the per-frame block in `world.ts` (drift, rise, dwell, retire) into `stepButt` in `butts.ts`, unchanged in behaviour. This is the move that was deferred twice; it is here because this phase adds four behaviours to it.

- [ ] **Step 4: The acceptance test**

This is the point of the task, and it must be a test that has to be **deleted** to reintroduce the bug, not merely edited:

```ts
test("attract mode cannot advance the clock, score, or spawn anything hostile", () => {
  const w = new World(makeNullSurface(), [
    { symbol: "UP", changePct: +1 },
    { symbol: "DOWN", changePct: -1 },
  ], () => {});
  w.attract();
  const before = { points: w.points, health: w.health, msLeft: w.msLeft };
  for (let i = 0; i < 600; i++) w.step(1 / 60);
  assert.equal(w.points, before.points);
  assert.equal(w.health, before.health);
  assert.equal(w.msLeft, before.msLeft);
  assert.equal(w.butts.filter((b) => b.hostile).length, 0);
});
```

Whatever access this needs, give it — a test-only getter is fine and better than the harness that reimplements the logic. **Delete the old hand-written attract harness** and its comment; this replaces it.

- [ ] **Step 5: Typecheck, suite, browser**

`npm run typecheck && npm test`, then open `/range` and confirm a round still plays exactly as before, and that disabling WebGL still shows the fallback with the board intact.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(site)/range" tests/range.test.ts
git commit -m "A range that can be played without a browser, so its wiring can be tested" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Two ranks, four behaviours

**Files:** `butts.ts`, `world.ts`, `tests/range.test.ts`

**Interfaces:** `butts.ts` exports `type Behaviour = "stand" | "drift" | "peek" | "swing"`, `RANKS = { near: { z: -22, faceScale: 1, bonus: 1 }, far: { z: -40, faceScale: 0.5, bonus: 2 } }`, and `pickBehaviour(wave: number, rng?: () => number): Behaviour`. `Butt` gains `behaviour` and `rank`.

- [ ] **Step 1: Failing tests first**

Cover, as relationships: a far-rank hit scores double a near-rank hit of the same ring; `pickBehaviour` returns only `stand` in wave 0 and can return all four by wave 2; `stepButt` moves a `drift` sideways and not a `stand`; a `peek` retires within its window whether or not it is hit; a `swing` stays within its arc. Inject the RNG so behaviour selection is deterministic in the test.

- [ ] **Step 2: Implement**

Faces at the far rank are half the size and worth double on top of the existing ring multiplier. The four behaviours live in `stepButt`, switched on `b.behaviour`.

- [ ] **Step 3: Verify, then commit** — `npm run typecheck && npm test`, play a round, commit as `Two ranks, and targets that do more than stand there`.

---

### Task 3: Reds that telegraph, and getting out of the way

**Files:** `butts.ts`, `world.ts`, `arrows.ts`, `sfx.ts`, `page.tsx`, `tests/range.test.ts`

- [ ] **Step 1: Failing tests first**

A hostile butt must spend `TELL_MS = 900` winding up before it looses, and must not loose during the wind-up; sidestep must clamp to ±3 units and ease back to centre when released.

- [ ] **Step 2: The tell**

A hostile butt about to fire turns its face to you and raises a red glow over 900 ms, then looses. The player has the arrow's flight time to move. `whistle` is implemented in `sfx.ts` **and called here** — a rising tone as the arrow nears, which is the first sound in this project whose pitch depends on something in the world, so drive it from the arrow's distance rather than a fixed sweep.

- [ ] **Step 3: Sidestep**

A and D, and the arrow keys, move the camera up to 3 units either side of centre and ease back when released. On touch, turning away is the answer and no control is added.

- [ ] **Step 4: Verify, then commit** — including a headless test that a telegraphed arrow can actually reach the player, which is the check Phase 1 lacked when its hostile arrows silently stopped working. Commit as `The reds wind up before they shoot, and you can step aside`.

---

### Task 4: Waves

**Files:** Create `waves.ts`; modify `world.ts`, `sfx.ts`, `tests/range.test.ts`

**Interfaces:** `waves.ts` exports `interface WaveState { wave: 0 | 1 | 2; maxUp: number; hostileShare: number; spawnEvery: number }` and `waveAt(elapsedMs: number): WaveState`. `Snapshot` gains `wave`.

- [ ] **Step 1: Failing tests first**

`waveAt` at 0, 19 000, 21 000, 44 000, 46 000 and 59 000 ms returns the spec's three bands, with `maxUp` and `hostileShare` rising and `spawnEvery` falling. Assert the ordering between bands, not just the literal numbers, so a retune does not silently invert the curve.

- [ ] **Step 2: Implement**

Wave 0 is 0–20 s, sparse, at most one red. Wave 1 is 20–45 s, filling, reds a third. Wave 2 is 45–60 s, up to nine up, half red, spawn interval halved. The light drops a little across the round and the music tightens in wave 2 — this is the tightening Phase 2 deliberately left alone, and it now has a `wave` to key off.

- [ ] **Step 3: Verify, then commit** as `A round that starts kind and ends badly`.

---

### Task 5: The last arrow, and the reckoning

**Files:** `world.ts`, `page.tsx`, `site.css`, `tests/range.test.ts`

- [ ] **Step 1: Slow motion**

The round's last arrow flies at 0.25× with the camera following it. If the timer ends with nothing in the air, the last two seconds slow instead. Implement as a time scale applied to `dt`, so nothing downstream needs to know.

- [ ] **Step 2: The results card**

Phase 2's card returns carrying the full result: score, hits from shots, accuracy, longest streak, best ring, the ticker that earned most, and where the score lands on this week's board. All of these already exist on the snapshot — **this task adds no new tracked state**, it displays what Phases 1 and 2 have been carrying.

- [ ] **Step 3: Verify, then commit** as `The last arrow, slowed, and then the damage`.

---

### Task 6: Something worth posting

**Files:** Create `share.ts`; modify `page.tsx`, `site.css`, `tests/range.test.ts`

- [ ] **Step 1: Failing tests first**

`share.ts` exports `shareLines(run): string[]` — the text the image prints — and `shareText(run): string` for the clipboard. Test both, including a run with zero shots, so accuracy cannot divide by zero on a card someone posts.

- [ ] **Step 2: Draw it**

A 1200×675 canvas: the score large, the run's numbers under it, the best ticker, a flat painted range behind, and the mark. No upload, no route, nothing leaves the browser.

- [ ] **Step 3: Offer it**

Clipboard where the browser allows, download where it does not. Remember the spec's rule: the copy never implies a return.

- [ ] **Step 4: Verify, then commit** as `A card worth posting, drawn in the browser`.

---

## Carried forward and deliberately deferred

- **The `IntersectionObserver` pause freezes the round clock** when the stage scrolls out of view, so a round can be held open indefinitely. It cannot inflate a score. Now that waves exist, decide whether to pause or forfeit; if the decision is to change it, that is its own task.
- Deferred minors from Phases 1 and 2, all still open and all still cheap: `stepWood`'s full traverse, `state.t` growing unbounded, the `endsLabel` duplication between the range page and `BoardCard`, the shadow bias never revisited at 13°, and `CREDITS.md`'s stale paths.

## Self-review against the spec

- Two ranks, sizes and doubled far-rank scoring: Task 2. Four behaviours: Task 2.
- Telegraphed hostile fire with a 900 ms tell and a whistle: Task 3. Sidestep to ±3 units: Task 3.
- Three waves with the spec's bands, the light drop and the music tightening: Task 4.
- Slow motion at 0.25×, the results card with all seven figures: Task 5.
- The 1200×675 share image, clipboard or download, no upload: Task 6.
- `Snapshot` gains `wave` and nothing else; everything the results card shows is already tracked.
- Opening with the headless seam is the ruling made after the third untested-wiring incident, with the acceptance test written so it must be deleted to reintroduce the bug.
