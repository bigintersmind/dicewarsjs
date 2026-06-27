/**
 * Deterministic 32-bit PRNG (mulberry32) — a tiny, dependency-free seeded random source.
 *
 * Shared by the PPO throughput probe (`ppo-probe-core.mjs`, the `random` learner) and the PFSP
 * opponent league (`ppo-league.mjs`, the per-episode opponent sampler). Lives in its own module so
 * the league does not have to import the benchmark tool (and, through it, the env runner) just to
 * borrow a PRNG — `ppo-probe-core.mjs` re-exports it for backward compatibility.
 *
 * Identical-seed → identical stream, so any consumer that seeds from the episode seed is fully
 * reproducible (no `Math.random`, which would make outcomes machine- and run-dependent).
 *
 * @module scripts/lib/mulberry32
 */

/**
 * @param {number} seed coerced to a uint32 (`seed >>> 0`).
 * @returns {() => number} next double in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
