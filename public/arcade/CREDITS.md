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

The draw's creak, the wind bed under a round and the music loop over it are
synthesised as well, for the same two reasons in different proportions. The
creak has to track a continuous value (how far the string is pulled), which a
fixed sample cannot do, so it is built the way the marker is: filtered noise
whose centre frequency and level both climb with the draw. The wind is a
band-passed noise loop kept deliberately under every effect's level, so it
reads as the floor the round stands on rather than as a sound of its own.

The music loop is a plain low drone — root, a copy of the root detuned by
exactly 1 / 8 Hz so it beats once slowly across the loop, a fifth and an
octave, all sine, all frequencies chosen as exact multiples of 1/8 Hz so
every partial completes a whole number of cycles across the buffer. That is
what makes it loop without a click: the waveform's value and slope at the end
of the buffer equal its value and slope at the start by construction, not by
trimming a recording and hoping. A CC0/CC-BY search for a loop that would fit
a quiet, license-safe floor under the round came up empty, and this was
easier to build exactly, and to prove seamless by measurement, than to source
blind and hope nobody minds.

## Everything else

The range itself — trees, hedges, palisade, the great oaks, the target faces,
Nottingham on the horizon — is generated in code in `src/app/arcade/world.ts`.
