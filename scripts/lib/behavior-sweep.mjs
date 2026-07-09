/**
 * The behavioral-profiling sweep — run one bot through `runCount × gamesPerRun × fieldSize`
 * rotations of an identical opponent field and reduce each seed block to per-axis scalars.
 *
 * Extracted (behavior-identical — same seed schedule) from `behavior-profile.mjs` so the
 * A/A negative control (`behavior-preflight.mjs`, PERSONAS §10.5) profiles the base through the
 * EXACT sweep personas are graded on. A re-implementation would test a copy, not the path the gate
 * actually uses — the whole point of an A/A is to exercise the real harness. (The A/A gets its two
 * arms by calling this twice at the SAME seeds. Pre-#151 the heuristic opponents picked with
 * unseeded `Math.random`, so the second pass diverged — that unseeded-opponent noise, with map
 * variance cancelled by the shared seeds, was the noise floor the paired signature gate sees.
 * Since #151 every built-in draws from the seeded `game.random()`, so a built-in field yields
 * identical arms and the A/A is a harness-determinism tripwire — `summarizeAaSample`'s
 * `zeroNoise` flag, which the pre-flight enforces as a HALT on any divergence ([D-34]).)
 *
 * @module scripts/lib/behavior-sweep
 */

import { runMatch } from '../../src/arena/matchRunner.js';

import { rotatedField } from './ppo-gate-core.mjs';
import { makeCapture, profileGameFromCapture, reduceRun, AXES } from './behavior-core.mjs';

/**
 * A run with no game contributing: every axis `null`. `winPct === null` is the "no data" marker a
 * caller's live-run count keys on, so a fully-quarantined run never reads as a measured "no diff".
 * @returns {Record<string, null>}
 */
export const nullRun = () => Object.fromEntries(AXES.map(a => [a, null]));

/**
 * Quarantine signal (§3.7): drop a game if ANY seat shows a forced-end (engine error, illegal move,
 * or the move-cap tripped) — a forced end is not a behavioral sample.
 * @param {{errors:number, invalidMoves:number, maxMovesHit:number}} s - one seat's botStats entry
 * @returns {boolean}
 */
export const isForcedEnd = s => s.errors > 0 || s.invalidMoves > 0 || s.maxMovesHit > 0;

/**
 * Sweep one bot in the single profiled seat of an identical field and reduce each seed block.
 *
 * @param {{name:string, fn:Function}} bot - the profiled bot (occupies seat 0 of the base field)
 * @param {object} opts
 * @param {Array<{name:string, fn:Function}>} opts.opponents - the fixed opponent field
 * @param {number} opts.runCount - seed blocks
 * @param {number} opts.gamesPerRun - map seeds per block
 * @param {number} opts.stride - seed stride between blocks (must exceed gamesPerRun so blocks are disjoint)
 * @param {boolean} [opts.quarantine=true] - drop forced-end games (§3.7)
 * @param {(run:number, runCount:number) => void} [opts.progress] - per-run progress callback
 * @returns {{ perRun: Array<Record<string, number|null>>, played:number, quarantined:number }}
 */
export function sweepBot(
  bot,
  { opponents, runCount, gamesPerRun, stride, quarantine = true, progress } = {}
) {
  const baseField = [bot, ...opponents]; // profiled bot at index 0
  const fieldSize = baseField.length; // rotation count = every seat gets the profiled bot once
  const perRun = [];
  let played = 0;
  let quarantined = 0;
  for (let run = 0; run < runCount; run++) {
    const baseSeed = run * stride + 1;
    const profiles = [];
    for (let s = 0; s < gamesPerRun; s++) {
      const seed = baseSeed + s;
      for (let rot = 0; rot < fieldSize; rot++) {
        // Under rotation `rot`, field[0] (the profiled bot) sits at seat `rot`.
        const field = rotatedField(baseField, rot);
        const pi = rot;
        const { capture, onTurn, onStep } = makeCapture(pi);
        try {
          const result = runMatch({ bots: field, seed, onTurn, onStep });
          played += 1;
          if (quarantine && result.botStats.some(isForcedEnd)) {
            quarantined += 1;
            continue;
          }
          // profileGameFromCapture is in the try too: its contract throws (misaligned capture /
          // seat mismatch) are genuine engine-contract violations and deserve the same coordinates.
          profiles.push(profileGameFromCapture(result, pi, capture));
        } catch (err) {
          // Surface which game blew up rather than dying with a context-free stack far from its
          // cause (this is inside runCount×games×rotations iterations).
          throw new Error(
            `match failed (bot=${bot.name} seed=${seed} rot=${rot}): ${err.message}`,
            {
              cause: err,
            }
          );
        }
      }
    }
    perRun.push(profiles.length ? reduceRun(profiles) : nullRun());
    if (progress) progress(run, runCount);
  }
  return { perRun, played, quarantined };
}
