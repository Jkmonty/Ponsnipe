/**
 * The round's pacing, as one pure function of how long it has been running.
 *
 * Everything else this phase added — two ranks, four behaviours, a telegraphed
 * shot you can step aside from — has been flat since the first second: the
 * same spawn rate, the same mix of green and red, whether the round is five
 * seconds old or fifty. This file is what gives it a shape: twenty seconds to
 * learn the game with almost nothing shooting back, twenty-five more filling
 * in, then a last fifteen seconds that is a storm.
 *
 * `waveAt` takes the round's own elapsed time and nothing else — no clock of
 * its own, no field mutated between calls — because that is what lets the
 * whole curve be asserted in a plain `node --test` case, the same seam
 * `attractStep` and `resolveButtHit` already proved out for the rest of the
 * round's rules. `world.ts` calls this once a frame with `ROUND_MS -
 * this.msLeft` and reads the result; nothing here remembers the last call.
 */
export interface WaveState {
  /** Which of the three bands this moment falls in, 0 (sparse) through 2
      (storm) — the same number `Snapshot.wave` carries out to the HUD, and
      the one `pickBehaviour` (see butts.ts) is handed so drift, peek and
      swing stay absent until the round has taught `stand` first. */
  wave: 0 | 1 | 2;
  /**
   * How many butts `world.ts`'s spawner will let stand at once — "two or
   * three", "four to six", "up to nine" in the spec's own words, read here
   * as each band's own upper bound rather than a range, since the spawner
   * already varies how many come up in a single volley below that ceiling.
   */
  maxUp: number;
  /**
   * The fraction of `maxUp` that may be red at once, not a per-spawn
   * probability by itself — `world.ts` turns it into a hard headcount via
   * `Math.round(maxUp * hostileShare)` (floored up to at least one once any
   * red is allowed at all) and refuses a new red past that count, which is
   * what actually makes wave 0 "at most one" rather than merely unlikely to
   * be more. The spec's "a third of them" and "half red" are literally this
   * fraction at wave 1 and wave 2; wave 0's 0.2 is chosen so that, against
   * `maxUp`'s own 3, the rounded headcount lands on exactly one.
   */
  hostileShare: number;
  /** Average seconds between spawn attempts — the spawner jitters around
      this rather than using it as a metronome, the same way it always has.
      Wave 2 is exactly half of wave 1, the one relationship the spec states
      outright ("spawn interval halved"); wave 0 to wave 1 has no such stated
      ratio, only that it must fall, which the ordering test below checks. */
  spawnEvery: number;
}

/** Wave 0 runs 0–20s: sparse, at most one red, only `stand`. */
const WAVE_0_END_MS = 20_000;
/** Wave 1 runs 20–45s: filling, reds a third, drift and peek join in. */
const WAVE_1_END_MS = 45_000;
/** Wave 2 runs 45–60s (and, if a round ever ran long, beyond): the storm,
    half red, every behaviour, double the spawn rate of wave 1. */

const WAVE_0: WaveState = { wave: 0, maxUp: 3, hostileShare: 0.2, spawnEvery: 1.6 };
const WAVE_1: WaveState = { wave: 1, maxUp: 6, hostileShare: 1 / 3, spawnEvery: 1.0 };
const WAVE_2: WaveState = { wave: 2, maxUp: 9, hostileShare: 0.5, spawnEvery: 0.5 };

/**
 * The wave a moment `elapsedMs` into the round falls in, and everything the
 * spawner needs to pace it — a pure lookup, so calling it twice with the same
 * argument always answers the same way. `elapsedMs` past `WAVE_1_END_MS`
 * (including anything at or beyond the round's own 60s) stays in wave 2
 * rather than needing a fourth band that will never exist; a negative
 * `elapsedMs`, which nothing in `world.ts` should ever pass but a test might,
 * clamps to wave 0 the same way.
 */
export function waveAt(elapsedMs: number): WaveState {
  if (elapsedMs < WAVE_0_END_MS) return WAVE_0;
  if (elapsedMs < WAVE_1_END_MS) return WAVE_1;
  return WAVE_2;
}
