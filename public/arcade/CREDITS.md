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

From Kenney's audio packs, both CC0 1.0 — https://kenney.nl/assets/impact-sounds
and https://kenney.nl/assets/rpg-audio. Renamed by role, three takes of most
things so the same waveform is never heard twice running.

| File | Original | Used for |
|---|---|---|
| `sfx/loose0-1.ogg` | RPG Audio `cloth1`, `cloth3` | bowstring and fletching on release |
| `sfx/thunk0-2.ogg` | Impact `impactSoft_heavy_000-002` | arrow into a straw butt |
| `sfx/wood0-2.ogg` | Impact `impactWood_medium_000-002` | arrow into the butt's frame |
| `sfx/hurt0-2.ogg` | Impact `impactPunch_heavy_000-002` | taking an arrow |
| `sfx/marker0-2.ogg` | Impact `impactMetal_light_000-002` | hit marker tick |
| `sfx/miss0-1.ogg` | RPG Audio `knifeSlice`, `knifeSlice2` | a shaft going past into the trees |

149 KB for the set, fetched only on `/arcade` and only once the player presses
Start. The horn, the combo chime and the low body of the bow release are still
synthesised in `src/app/arcade/sfx.ts` — a tuned sound that has to rise with a
counter cannot be a fixed recording, and no small sample carries the thump of a
stave the size of a person. Every recorded sound falls back to its synthesised
version if the download fails.

## Everything else

The range itself — trees, hedges, palisade, the great oaks, the target faces,
Nottingham on the horizon — is generated in code in `src/app/arcade/world.ts`.
