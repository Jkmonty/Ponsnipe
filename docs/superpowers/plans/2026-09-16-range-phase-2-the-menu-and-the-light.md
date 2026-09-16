# Range Phase 2: The Menu and the Light — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the range onto a wood worth looking at, instead of a black box with a button in it.

**Architecture:** The light, the sky and the atmosphere are built in `scene.ts`, which already owns the wood. `World` gains an attract mode: the scene runs from page load with the camera drifting, no score and no danger, so the menu sits over a living range rather than a void. `page.tsx` gets the full-width stage and the glass card. Sound gains a wind bed, a music loop and the draw creak that Phase 1 wired but left silent.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, three.js 0.186 (already present, loaded only on this route), Web Audio through the existing `sfx.ts`, plain CSS.

**Spec:** `docs/superpowers/specs/2026-09-15-range-rebuild-design.md` — read it. This plan implements its "The menu" and "The look and the sound" sections and nothing else.

## Global Constraints

- Node `>=22.5.0`. **Add no dependencies**; three.js is already present.
- Nothing outside `src/app/(site)/range/`, `src/app/(site)/site.css`, `public/arcade/` and `tests/` changes. **`src/app/globals.css` belongs to the trading terminal and must not be touched.**
- three.js must not leak outside `src/app/(site)/range/`; the terminal's bundle must never gain it.
- Comments explain **why**, in plain prose, matching the voice already in these files.
- **Phase 3 work must not leak in.** Two ranks, target behaviours, telegraphed incoming arrows, sidestepping, waves, slow motion, the results card and the share image are all Phase 3. In particular: the spec says the music "tightens for wave 2" — waves do not exist yet, so ship one loop and leave the tightening to Phase 3.
- **No sound without a caller.** Phase 1 shipped two things that were set but never read, both caught in review rather than by tests. `creak` gets implemented here because Phase 1 already wired its call site. The incoming-arrow `whistle` does **not**, because nothing fires a telegraphed arrow until Phase 3.
- Round shape is unchanged: 60 seconds, three arrows taken, `/api/arcade` payload untouched.
- Assets: **CC0 or CC-BY only, never non-commercial**, because the site charges a trading fee. Every new file goes in the table in `public/arcade/CREDITS.md` with author, licence and source. glTF or Ogg only; the range's total assets stay under 6 MB.
- Dev servers start ONLY through the Browser tools, never Bash. `.claude/launch.json` has `ponsnipe` and `ponsnipe-public`; only one may run at a time, and either serves `/range`.
- **The Browser pane throttles `requestAnimationFrame` when it is not painting, so a round does not advance on its own there.** A check that watches the clock and sees nothing change has proved nothing. Drive the loop by hand instead: `window.__arcade` is the live `World`, and `g.step(1/60)` in a loop runs a real round deterministically. This is how Phase 1's final verification was done after two earlier attempts looked like success and proved nothing.
- If `npm run typecheck` fails only on generated files under `.next/types` or `.next/dev/types`, run `npx next typegen` once and re-run.
- Do not commit `.claude/launch.json`, anything under `.superpowers/`, `.env`, or anything under `.next`.
- Commit messages: a short plain sentence saying what changed and why, then the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Quote paths containing parentheses.

---

## File map

| Path | Responsibility |
|---|---|
| `src/app/(site)/range/scene.ts` | Gains the sky, the low sun, shadows, the warm fog, the motes; loses its import cycle |
| `src/app/(site)/range/butts.ts` | Red butts gain the hard rim that keeps them red in orange light |
| `src/app/(site)/range/world.ts` | Renderer tone mapping and shadows; attract mode |
| `src/app/(site)/range/page.tsx` | Full-width stage, the glass menu card, the between-rounds result |
| `src/app/(site)/site.css` | The card, the stage, the chips |
| `src/app/(site)/range/sfx.ts` | `creak`, the wind bed, the music loop |
| `public/arcade/CREDITS.md` | Every new asset recorded |
| `tests/range.test.ts` | Ring-legibility and attract-state tests |

---

### Task 1: Golden hour

**Files:**
- Modify: `src/app/(site)/range/scene.ts`
- Modify: `src/app/(site)/range/butts.ts`
- Modify: `src/app/(site)/range/world.ts` (renderer only)

**Interfaces:**
- Produces: `scene.ts` exports `SUN_ANGLE_DEG = 8`, and `buildWood` returns `Wood` unchanged in shape. `butts.ts` exports `HOSTILE_RIM` for the red rim colour.
- Also: **break the `scene.ts` ↔ `butts.ts` import cycle.** `scene.ts` imports `LANES` from `butts.ts` while `butts.ts` imports `rand` from `scene.ts`. It is safe today only because both are read inside function bodies; one top-level use turns it into an import-time crash. Move `rand` into a new leaf module `src/app/(site)/range/rand.ts` that imports nothing, and have both import from there.

- [ ] **Step 1: Break the cycle first**

Create `src/app/(site)/range/rand.ts`:

```ts
/**
 * One random helper, in a module that imports nothing.
 *
 * `rand` used to live in scene.ts while scene.ts imported LANES from butts.ts
 * and butts.ts imported rand back — a cycle that was safe only because both
 * bindings were read inside function bodies. A single top-level use would have
 * turned it into a crash at import. A leaf module costs nothing and removes
 * the trap.
 */
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
```

Re-point `scene.ts` and `butts.ts` at it, and remove the re-export from `scene.ts`. Typecheck: the cycle is gone.

- [ ] **Step 2: The renderer learns about light**

In `world.ts`'s constructor, beside the existing `WebGLRenderer`:

```ts
    // Shadows and a filmic curve. The wood is flat-shaded low-poly, which
    // reads as cardboard under a flat light — the long shadows of a low sun
    // are what give it depth, and ACES stops the warm sun clipping to white
    // where it lands.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
```

- [ ] **Step 3: The sky and the sun**

In `scene.ts`'s `buildWood`, replace the flat `scene.background` and the current lights:

- **Sky:** a large `BackSide` sphere with a vertical gradient shader or a canvas-drawn gradient texture — deep blue `#16243a` at the top, through `#6b4a3a`, to a hot band `#e08a3c` and `#f4b35a` at the horizon. A flat colour cannot give the orange band the spec asks for.
- **Sun:** `DirectionalLight`, colour `0xffd9a0`, intensity `2.4`, positioned low and to the right at `SUN_ANGLE_DEG = 8` above the horizon. Enable `castShadow`, set `shadow.mapSize` to 2048×2048, and fit the orthographic shadow camera to the range so the far rank is inside it rather than being cut off.
- **Ambient:** drop to roughly `0.55` and tint it cool (`0x6a7f9a`), so shadowed sides read as sky-lit rather than as the same green as the lit sides. This is what makes a low sun look low.
- **Fog:** warm, `0xd8a367`, starting at 45 units as the spec says, ending around 190 so the castle is a shape rather than a silhouette on nothing.

Set `castShadow` on trunks, posts and butt groups, and `receiveShadow` on the ground and the hedges. Do not set both on everything; a shadow map has a budget.

- [ ] **Step 4: Keep the reds red**

In `butts.ts`, a hostile butt gets a hard rim — a slightly emissive ring material in `HOSTILE_RIM` around the face — so it reads as red at 40 units under orange light. This is the one rule in the whole game that cannot bend: a share that is down today must look down today.

- [ ] **Step 5: Motes and the castle**

Pollen drifting in the sun's beam: a single `Points` cloud of a few hundred sprites in a slab over the range, drifting slowly upward and looping. One buffer, updated in place, not new objects per frame. The existing `tower` becomes readable as Nottingham by sitting in the fog band rather than in front of it.

- [ ] **Step 6: Typecheck, suite, and look at it**

Run: `npm run typecheck && npm test`
Expected: clean; 190 passing.

In the browser at 1280×800 on `/range`, press Start and drive the loop by hand (`g.step(1/60)` in a loop) so the scene renders a real frame. Screenshot it. Expected: a low sun on the right, an orange horizon into blue, long shadows from the posts and trees, warm haze with the castle inside it, and red butts that still read as red.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(site)/range"
git commit -m "Golden hour: a low sun, long shadows, and a horizon worth looking at" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Attract mode

**Files:**
- Modify: `src/app/(site)/range/world.ts`
- Modify: `src/app/(site)/range/page.tsx`
- Test: `tests/range.test.ts`

**Interfaces:**
- Produces: `World` gains `attract()`, which starts the render loop in a mode with no score, no danger and no input; `start()` leaves attract and begins a real round. `Snapshot` gains `attract: boolean`.

- [ ] **Step 1: Write the failing test**

Attract mode's rules are testable without a canvas if the decision is a pure function. Add to `tests/range.test.ts` a test over an exported `attractStep(state, dt)` or equivalent that asserts: in attract, the clock does not run, no hostile butt fires, the score cannot change, and health cannot drop. Assert each as a relationship, not a number read from output.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test tests/range.test.ts`
Expected: FAIL on the missing export.

- [ ] **Step 3: Implement attract**

`attract()` builds the world and runs the loop with `attracting = true`. In that mode `step` skips the clock, the spawn of hostiles, all shooting and all damage, but does run butt rising and drifting so the range looks alive. The camera drifts slowly along the range on a long sine, looking at the middle distance; `look()`, `fire()`, `beginDraw()` and `touchFire()` all refuse while attracting.

`page.tsx` calls `attract()` on mount rather than showing a black box, and `play()` calls `start()`.

- [ ] **Step 4: Typecheck, suite, and watch it drift**

Run: `npm run typecheck && npm test`
Expected: clean; suite up by the new tests.

In the browser: the range is visible and moving before Start is pressed, clicking does nothing, and nothing shoots at you. Press Start and a real round begins.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(site)/range" tests/range.test.ts
git commit -m "The range is alive before you press Start" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The stage and the card

**Files:**
- Modify: `src/app/(site)/range/page.tsx`
- Modify: `src/app/(site)/site.css`

- [ ] **Step 1: The stage**

The stage becomes full width at 16:9 with the board **below** it rather than beside it. The existing `.range-grid` two-column rule goes; the stage takes the content column and the board sits under it at full width. `fit()` keeps sizing the canvas; only its box changes.

- [ ] **Step 2: The card**

Over the attract scene, a dark glass panel: `rgba(8,12,9,.78)` with a blur, a hairline, and the panel radius. Inside it, in order:

- the label `SHERWOOD · ROBINHOOD CHAIN` in gold mono
- the title in Fraunces
- one line of rules, the existing copy
- **today's targets as chips**, each a ticker and its day move, green up and red down, from the targets the game already loads
- the top three of the board with the week's end, from the board the page already fetches
- the lime **Draw the bow** button
- the controls line in mono: `HOLD TO DRAW · RELEASE TO LOOSE · RIGHT-CLICK FOR THE SCOPE`, and on touch `TAP TO FIRE · DRAG TO AIM`

- [ ] **Step 3: The same card, after a round**

When a round ends the card returns carrying the result instead of the rules: the score, hits from shots, and the posted line that already exists. **No results card, no accuracy, no streak, no share** — those are Phase 3.

- [ ] **Step 4: Typecheck and look at it, desktop and phone**

Run: `npm run typecheck && npm test`

In the browser at 1280×800: the stage is full width, the card sits over a drifting wood, the chips show today's tickers, the board's top three are on the card. At `mobile` preset: the card fits, nothing overflows horizontally, the controls line shows the touch wording. Reset to `desktop` after.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(site)"
git commit -m "A menu that opens onto the wood, not a black box" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Wind, a loop, and the creak

**Files:**
- Modify: `src/app/(site)/range/sfx.ts`
- Modify: `public/arcade/CREDITS.md`
- Possibly add: `public/arcade/sfx/*.ogg`

- [ ] **Step 1: The creak**

Phase 1 wired `sfx?.creak?.(draw)` and left it silent. Implement it synthesised, in the style `sfx.ts` already uses for the marker: a short filtered-noise rasp whose centre frequency and gain rise with the draw, quiet enough to sit under everything. Synthesised rather than recorded for the same reason the marker is: it has to track a continuous value, which a sample cannot.

- [ ] **Step 2: The wind bed**

A continuous low noise bed, band-passed and slowly modulated, starting when a round starts and fading out when it ends. It must be quiet: this is the floor the other sounds stand on, not a feature.

- [ ] **Step 3: The music loop**

One loop under the round. If a suitable CC0 or CC-BY loop is found, ship it as Ogg and record it in `CREDITS.md`; if not, a simple synthesised drone built the way the existing sounds are is acceptable and honest. **One loop only** — the spec's "tightens for wave 2" belongs to Phase 3, which is where waves exist.

- [ ] **Step 4: Verify by measurement, not by ear**

Nobody involved can hear this. Use the bench the project already has at `/range/sounds`, and verify the creak, the wind and the loop by rendering them offline through the existing `__bench` handle and checking the numbers: that the creak's centre frequency rises with the draw, that the wind's level sits below the effects, and that the loop actually loops without a click at the seam.

- [ ] **Step 5: Typecheck, suite, commit**

Run: `npm run typecheck && npm test`

```bash
git add "src/app/(site)/range/sfx.ts" public/arcade
git commit -m "Wind under the wood, a loop over it, and the bow finally creaks" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

- **Attract mode, camera drifting, no danger:** Task 2.
- **Full-width 16:9 stage, board below:** Task 3.
- **Glass card: title, rules, target chips, board top three, Draw the bow, controls line:** Task 3.
- **The card returns between rounds with the result:** Task 3, deliberately without Phase 3's results card.
- **Golden hour: sun at 13° (raised from this plan's original 8° — see scene.ts's SUN_ANGLE_DEG, where 8° left the ground too dark to read), 2.4 intensity, orange into blue, fog from 45:** Task 1.
- **Shadow maps at 2048, motes, castle in the fog:** Task 1.
- **Red butts keep a hard rim:** Task 1, step 4.
- **Wind, a music loop, the draw creak:** Task 4.
- **Assets CC0 or CC-BY, credited:** Task 4, and the global constraints.
- **Carried from Phase 1:** the import cycle is broken (Task 1), and the silent creak gets its sound (Task 4).
- **Deferred to Phase 3, deliberately absent here:** two ranks, behaviours, telegraphed arrows and the whistle, sidestepping, waves and the music tightening, slow motion, the results card, the share image, and moving the per-frame butt loop into `butts.ts` (which belongs with the task that adds more butt behaviour).
