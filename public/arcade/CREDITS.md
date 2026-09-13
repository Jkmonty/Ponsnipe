# Arcade assets

All third-party assets in the range are CC0 (public domain). CC0 requires no
attribution — this file exists so the provenance of anything shipped in the app
is recorded, and so the next person adding an asset knows the bar: **CC0 or
CC-BY only, never non-commercial**, since Ponsnipe charges a trading fee and is
therefore a commercial work.

## Models

| File | What | Author | Licence | Source |
|---|---|---|---|---|
| `bow.glb` | Wooden Bow, 660 tris, untextured | Quaternius | CC0 1.0 | https://poly.pizza/m/QnpqjLSKFU |

## Sound

Two recorded sounds remain, both CC0 from Kenney's
[Impact Sounds](https://kenney.nl/assets/impact-sounds) and
[RPG Audio](https://kenney.nl/assets/rpg-audio) packs, renamed by role.

| File | Original | Used for |
|---|---|---|
| `sfx/hurt0-2.ogg` | Impact `impactPunch_heavy_000-002` | taking an arrow |
| `sfx/miss0-1.ogg` | RPG Audio `knifeSlice`, `knifeSlice2` | a shaft going past into the trees |

Three takes of the hit, so the same waveform is never heard twice running.
Around 60 KB, fetched only on `/arcade` and only once Start is pressed, and
every one falls back to a synthesised version if the download fails.

Recorded takes for the bow release, the arrow landing and the hit marker were
tried and dropped. The release take was cloth, and sounded like cloth. The
marker wanted to be one specific sound — the short dry metallic tick every
shooter uses — which is easier to build exactly than to find: about forty
milliseconds, nearly all its energy near 4 kHz, three partials at deliberately
inharmonic ratios so it reads as struck metal rather than as a beep. The
original of that sound is Activision's and not ours to ship; this is the same
species of sound, built from scratch in `src/app/arcade/sfx.ts`.

The arrow landing is synthesised too, and deliberately low and quiet — it
fires at the same instant as the marker, and three effects stacking on one hit
is how a confirmation turns into mush.

## Everything else

The range itself — trees, hedges, palisade, the great oaks, the target faces,
Nottingham on the horizon — is generated in code in `src/app/arcade/world.ts`.
