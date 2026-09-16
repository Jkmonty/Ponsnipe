# The range, rebuilt

*Design spec, 15 September 2026. Brainstormed against the running game with
three painted mood boards; the chosen one is described here rather than
attached, since the mockups live in `.superpowers/brainstorm/` and are not
committed.*

## What this is

The Sherwood Shooting Range works and is not enjoyable. A click is an instant
raycast, the menu is a black box with a button, the stage is smaller than the
page it sits in, targets are small and far, and a hit gives almost nothing
back. This turns it into a game worth a second go, and worth posting a score
from.

## Decisions already made

These came out of the brainstorm and are not open.

| Question | Answer |
|---|---|
| Platforms | Desktop and phone both |
| Scope this round | Feel, danger, ending and look, all four |
| Round shape | Unchanged: 60 seconds, six arrows taken ends it (the spec previously said three; the game has always had 100 health at 18 a hit, which is six, and the code is what ships) |
| Light | Golden hour: low sun, long shadows, warm haze |
| Desktop shot | Click to shoot: one click, one arrow, immediately, at the same fixed draw a tap uses (the spec previously said hold to draw, release to loose, with the draw setting power; the user reversed that decision after playing it — "just make it tap to shoot and click to shoot on pc" — and a reversal by the person the game is for outranks a brainstorm) |
| Phone shot | Tap to fire at a fixed draw; drag to aim |

## Non-goals

- No Unity, no WebGL export, no engine change. Three.js in the page stays.
- No change to the board, `/api/arcade`, the scoring table, or the weekly
  reset. A score posted by the new game is the same row as before.
- No change to the site outside `src/app/(site)/range/`. The share card is
  drawn in the browser, so it needs no route and no upload.
- No account, no login, no server-side replay. The board stays as honest as it
  is, and no more.
- No multiplayer.

## Architecture

`world.ts` is 1,012 lines and builds scenery, runs targets, simulates arrows
and keeps score. The new work lands in all four of those, so it splits first,
by responsibility.

```
src/app/(site)/range/
  world.ts      the camera, the loop, the score, the snapshot   (slimmed)
  scene.ts      the wood: sky, sun, shadows, fog, trees, castle  (new)
  butts.ts      targets: spawn, rise, drift, retire, scoring     (new)
  arrows.ts     everything in flight, yours and theirs           (new)
  share.ts      the results image, drawn on a canvas             (new)
  sfx.ts        unchanged, plus whistle()
  kit.ts        unchanged
  page.tsx      the menu, the HUD, the results card
```

Each new module exports plain functions over data it is handed. `World` owns
the state and calls them; they do not reach back into `World`. That keeps the
loop readable and lets the scoring and pacing maths be tested without a canvas.

**The snapshot grows** by what the new HUD and results card need, and nothing
more:

```ts
export interface Snapshot {
  points: number; health: number; lives: number;
  hits: number; shots: number; combo: number;
  msLeft: number; over: boolean;
  mark: number; markKill: boolean; hurt: number;
  /** 0..1, how far the next arrow is back on the string after a shot — the
      nock's refill, which is the whole of the rate of fire. This field was
      `draw`, how far the bow was pulled back right now, desktop only; there
      is no pull to report since the desktop hold was reversed, and the
      refill is what the HUD's meter has to show instead. */
  nock: number;
  /** Longest run of hits without a miss this round. */
  streak: number;
  /** Best ring struck this round: 1 gold, 2 red, 3 blue, 4 black, 5 white. */
  bestRing: number;
  /** The ticker that earned the most this round, for the share card. */
  bestSymbol: string;
  /** Which wave is running, 0..2, so the HUD can tighten in the storm. */
  wave: number;
}
```

## The shot

The single biggest change: **your arrow becomes a projectile**. It leaves the
bow, arcs under gravity, and takes time to arrive.

- Speed from the draw: the curve runs 28 m/s at a slack string to 55 m/s at a
  full pull, and every shot the game actually looses sits at the one fixed
  draw of 0.8, which is 49.6 m/s (the spec previously quoted the two ends as
  the speeds a player would see, which was written while the desktop hold let
  them pick a point on the curve; that decision was reversed, so the curve is
  now a mapping with a single input). Gravity 9.8 m/s², so a shot at the far
  rank passes 7.3 to 9.1 units under what it was aimed at, and one at the near
  rank 3.6 to 5.4 — not the "about a metre" the spec previously estimated,
  which was written from the outside and is out by something like an order of
  magnitude, partly because the butts' real spawn positions (`x = rand(-30,
  30)`) put a far-rank face 60 to 67 units away rather than the 40 the
  geometry section quotes. Nor does the player aim high for it: `fire`
  raycasts the aim, measures the range to whatever is under the reticle, and
  launches at the elevation that lands the arrow there — about 5° of holdover
  at the near rank and 7° at the far. The drop is exactly as real as it was;
  the arrow simply now goes where the reticle says it goes, and the lead a
  moving target needs is unchanged. The same solver (`ballisticElevation`)
  aims the hostiles' arrows.
- Both your arrows and theirs run through one integrator in `arrows.ts`, with
  a flag for whose they are.
- An arrow that hits sticks in what it hit and fades over three seconds. One
  that misses thuds into the palisade or the ground. At most 24 stuck arrows
  live at once; the oldest is retired first.

### Loosing

*This section previously described a desktop hold: `draw` running 0 → 1 over
700 ms, a 0.15 floor under which a stray click loosed nothing, the field of
view creeping in by four degrees, a creak rising in pitch, and the aim
wandering by up to a degree once the pull was held past 1.4 seconds. The user
reversed that decision — "just make it tap to shoot and click to shoot on pc"
— so none of it survives. What is written below is what the game does.*

One press, one arrow, on both platforms:

- A click on a mouse or a tap on a screen looses immediately, at a fixed draw
  of 0.8. There is nothing to hold, nothing to release and no meter of the
  pull, because the player no longer sets it. It fires on pointer *down*.
- The bow kicks, the camera kicks by 0.9 degrees and settles over 200 ms, and
  the nock refills over 420 ms before another shot is allowed.
- That 420 ms is the entire rate of fire, and it is the same number on both
  platforms, so a click and a tap get the same arrows out of the same seconds
  of clock. Both platforms post to the same weekly board, so this is a
  correctness property and not a balance one; `tests/range.test.ts` holds the
  two paths equal rather than pinning either count.
- The fixed draw stayed at the 0.8 the tap already used rather than rising to
  a full 1. It was tuned against the ranks' real distances and the wave
  pacing across three phases of work, and raising it would have retuned the
  difficulty of a scoring round as a side effect of an input change.
- Aim assist still splits by input, and only by input: a thumb gets 3.9° of
  steering to a cursor's 2.6°, because a thumb is both the aim and the
  trigger. That is unchanged and deliberate — it is which device fired, not
  which draw was used.

### Magnetism

Today a miss inside 2.6° is snapped onto the target. With travel time that
becomes a small steering force on the arrow in flight, toward the nearest
target within 2.2° of its path, strong enough to forgive a pixel and far too
weak to rescue a bad shot. The pull is 1.5× stronger on touch, because a
thumb is not a mouse. A shot with no target near its path flies straight.

### A hit

- The butt rocks back on its post and settles.
- The ticker chip pops off the face and floats up, showing the points earned,
  then fades.
- The combo counter climbs in the corner; every five in a row rings the chime
  that already exists.
- Rings score: gold 3×, red 2×, blue 1.5×, black and white 1×, on top of the
  existing base and distance bonus. The gold tick is brighter and louder.
- A red butt struck is destroyed rather than scored, and stops shooting.

## Targets and danger

**Two ranks.** A near rank about 22 units out with large faces, and a far rank
about 40 units out with faces half the size, worth double. Both already exist
as lanes; this widens the gap and the size difference so the choice between a
safe shot and a good one is real.

**Behaviours**, chosen per target when it rises:

| Behaviour | What it does |
|---|---|
| Stand | Rises and stays, as now |
| Drift | Tracks sideways along its rank |
| Peek | Rises, and drops whether hit or not, on the tightest window its rank allows |
| Swing | Hangs from a branch and swings through a shallow arc |

**How long a target stays up** is derived, not chosen. Every dwell starts at
`minimumDwell(rank)` — the time to notice a target and put the reticle on it,
plus the time the one shot this game looses actually spends in the air
reaching the far corner of that rank — and differs only in how far past that
floor it may run: a `peek` not at all, a green butt by up to 0.7 s, a red one
by up to 1.1 s. That works out at 1.85 s at the near rank and 2.17 s at the
far.

*This is new. The spec previously gave `peek` a flat 1.8 seconds and said
nothing at all about the others, which were `rand(0.5, 1.2)` for a green butt
and `rand(1.3, 2.4)` for a red one. Those numbers date from the original
arcade, when a click was an instant raycast and a target only had to be up at
the moment you clicked. Phase 1 gave arrows travel time and nothing revisited
them, so a green butt was up for 0.5 to 1.2 seconds against a flight of 1.37 s
to the far rank: a far-rank green target was not hittable at any x, and a
near-rank one was a coin toss. Measured in a live round, a dead-centre shot at
a standing butt connected 2 times in 42 at the far rank and 50 in 78 at the
near. It is now 63 in 63 and 77 in 77. The arc, the travel time and the lead a
moving target needs are all unchanged; what was wrong was that a target's life
was set before any of them existed.*

**Incoming arrows.** A red butt winds up over 900 ms with a visible tell, the
face turning to you and a red glow rising, then looses an arrow at 34-42 m/s (the speed the game has always used; the spec previously said 30, which never matched the code) with
a whistle that rises as it nears. You have the flight time to move. Today the
hit simply happens; this is the change that makes being shot at a thing you
play against rather than a thing that occurs.

Getting hit costs 18 health as now, flashes the vignette, and resets the
combo.

**Pacing**, three waves inside the same 60 seconds:

| Wave | Seconds | What it is |
|---|---|---|
| 0 | 0–20 | Sparse. Two or three butts up, at most one red. |
| 1 | 20–45 | Filling. Four to six up, reds a third of them, drift and peek appear. |
| 2 | 45–60 | Storm. Up to nine up, half red, all behaviours, spawn interval halved. |

The light drops a little through the round and the music tightens in wave 2.

## The menu

The black overlay goes. `World` gains an **attract mode**: the scene runs from
page load with the camera drifting slowly along the range, butts rising and
settling, no score, no danger, nothing to shoot.

- The stage becomes full width at 16:9, with the board below rather than
  beside it.
- The card over it is dark glass: the title in Fraunces, one line of rules,
  today's targets as coloured chips, the top three of the board with the
  week's end, a lime **Draw the bow** button, and the controls line beneath.
- The same card returns between rounds carrying the result instead of the
  rules.

## The ending

- The round's last arrow flies at **0.25× speed** with the camera following it
  in. If the round ends on the timer with no arrow in the air, the last two
  seconds slow instead.
- Then the **results card**, over the still scene: score, hits out of shots,
  accuracy, longest streak, best ring, the ticker that earned most, and where
  the score lands on this week's board.
- **Share** draws a 1200×675 image on a canvas in `share.ts`: the score large,
  the run's numbers under it, the best ticker, the range behind it as a flat
  painted backdrop, and the mark. It offers the image through the clipboard
  where the browser allows it and as a download where it does not, with a
  prefilled line of text to paste. No upload, no new route, nothing leaves the
  browser.
- Posting to the board works exactly as it does now.

## The look and the sound

Golden hour. Sun low on the right at about 8° above the horizon, warm white
light at 2.4 intensity, sky an orange band into deep blue, fog warm and
starting at 45 units. Real shadow maps from the sun, 2048px, cast by posts,
trees and butts. Pollen motes drifting through the light. Nottingham a darker
shape in the fog.

**Red butts keep a hard red rim** and a slight emissive glow, because orange
light on a red face at 40 units is the one way this palette could break the
game's only rule that matters: a bad day must read as red.

Sound gains a wind bed under everything, a slow music loop that tightens for
wave 2, and the incoming whistle. (A draw creak was specified and built here
too: a rasp whose pitch climbed with the pull. It was retired with the pull
itself — it existed to track a continuously changing value, and a click has
none to track.) Everything falls back to
silence rather than blocking the game, as the current sounds already do.

### Assets

The bar in `public/arcade/CREDITS.md` stands: **CC0 or CC-BY only, never
non-commercial**, because the site charges a trading fee. Every new file is
recorded in that table with its author, licence and source. Preference in
order: Quaternius and poly.pizza, Kenney, Poly Haven, Sketchfab filtered to
CC0. glTF only, each under 2 MB, and the whole range's assets under 6 MB.
Anything not found under those terms is generated in code, as most of the wood
already is.

## Controls

| | Desktop | Phone |
|---|---|---|
| Aim | Mouse, pointer-locked; cursor if refused | Drag |
| Shoot | Click left (the spec previously said hold to draw, release to loose; reversed by the user) | Tap |
| Scope | Hold right | Two-finger hold |
| Move | A and D, or arrow keys, to sidestep | Swing the view |

Sidestepping moves the camera up to 3 units either side of centre and eases
back when released. It is the answer to an incoming arrow on desktop; on a
phone, turning away is.

## Failure

Every piece degrades rather than blocking.

| If | Then |
|---|---|
| WebGL is unavailable | The stage shows the painted poster and a line saying the range needs WebGL. The board still renders. |
| The bow model fails to load | Hands and arrow only, as now. |
| A sound file fails | That sound is silent; the round plays. |
| Targets are unavailable | The existing "no stock targets" state, unchanged. |
| The clipboard is refused | The share image downloads instead. |
| Reduced motion is set | Attract drift, screen shake and the last arrow's slow-motion camera are off; the game plays. The clock's own last two seconds still slow down for everyone (this row previously said slow motion was off outright, which was written before the ending had two branches to tell apart). That tail moves no camera, and it is time the player is still shooting in: the nock runs on the slowed clock too, so turning it off for one setting and not the other would let an accessibility flag change how many arrows a round gets away, and so the score it posts. (It said "the nock and the pull" until the pull was removed.) |

## Testing

The repo's pattern: `node --test` over pure functions, browser verification for
the rest.

- `tests/range.test.ts`: the draw-to-speed curve at both ends and in the
  middle; ring multipliers; combo and streak counting, including that a miss
  resets the combo but keeps the best streak; the wave schedule at second 0,
  19, 21, 44, 46 and 59; the aim-assist angle test accepting inside and
  rejecting outside.
- `tests/share.test.ts`: the results text layout, meaning the lines the card
  prints for a given run, including an accuracy of zero shots.
- The existing 165 tests and `npm run typecheck` stay green.
- In the browser: a full round on desktop and at phone size, the menu's
  attract mode, an incoming arrow dodged, the results card, the share image,
  and reduced motion.

## Phases

Each ships on its own and is worth shipping.

1. **The shot.** The file split, projectile arrows, draw and release, tap to
   fire, magnetism, hit reactions.
2. **The menu and the look.** Attract mode, the card, the full-width stage,
   golden hour, shadows, fog, motes, wind.
3. **Danger and the ending.** Two ranks, behaviours, telegraphed incoming
   arrows, sidestep, waves, slow motion, results card, share.
