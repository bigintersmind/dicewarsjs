/**
 * Seeded Pseudo-Random Number Generator
 *
 * Mulberry32 — a fast, high-quality 32-bit PRNG with a single uint32 state.
 * Deterministic: same seed always produces the same sequence.
 *
 * @module engine/rng
 */

/**
 * Create a seeded random number generator.
 *
 * @param {number} seed - Initial seed (integer). Converted to uint32 internally.
 * @returns {Object} RNG instance with next, nextInt, nextFloat, shuffle, state.
 */
export function createRng(seed) {
  let s = seed >>> 0; // coerce to uint32

  /**
   * Advance the state and return a float in [0, 1).
   * @returns {number}
   */
  function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }

  /**
   * Return a random integer in [min, max] (inclusive).
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function nextInt(min, max) {
    if (min > max) {
      throw new RangeError(`nextInt: min (${min}) must be <= max (${max})`);
    }
    return min + Math.floor(next() * (max - min + 1));
  }

  /**
   * Return a random float in [0, 1).
   * Alias for next().
   * @returns {number}
   */
  function nextFloat() {
    return next();
  }

  /**
   * Fisher-Yates shuffle (in-place, deterministic).
   * @template T
   * @param {T[]} arr - Array to shuffle in place.
   * @returns {T[]} The same array, shuffled.
   */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Get the current internal state for serialization.
   * @returns {number} The uint32 state value.
   */
  function state() {
    return s >>> 0;
  }

  return { next, nextInt, nextFloat, shuffle, state };
}

/**
 * Derive a seeded `random()` function for a bot decision (issue #151).
 *
 * Bots must never call the global `Math.random` — it breaks same-seed match
 * reproducibility. Instead each bot decision gets its own throwaway stream,
 * derived from the engine's current `state.rngState` mixed with the acting
 * player's id. Freshness across decisions comes from the engine itself:
 * `applyAction(ATTACK)` always advances `rngState`, and every applied move sits
 * between consecutive decisions of a turn, so re-deriving per decision yields a
 * new stream each time. The playerId mix keeps seats distinct even across a
 * zero-draw END_TURN (reinforcement placement with nothing to place), and the
 * `playerId + 1` offset guarantees the bot stream never coincides with the
 * engine's own `createRng(rngState)` battle stream (`0x9e3779b9` is odd, i.e. a
 * unit mod 2^32, so times the nonzero `playerId + 1` the product is never 0 mod
 * 2^32, and the xor always displaces the seed).
 *
 * The only state that repeats between two decisions is an invalid-move retry
 * (no applyAction ran) — the bot then redraws the same values, repeats the
 * move, and trips the consecutive-invalid cap, exactly like any deterministic
 * bot today.
 *
 * Reproducibility, not secrecy: the derivation is invertible in principle, so
 * a determined bot could recover engine RNG state from its draws. Community
 * bots land via reviewed PRs, which is the actual integrity boundary here.
 *
 * @param {number} rngState - The engine state's current `rngState` (uint32)
 * @param {number} playerId - The acting player's id
 * @returns {() => number} Seeded drop-in for `Math.random`: floats in [0, 1)
 */
export function deriveBotRandom(rngState, playerId) {
  // Fail loud (issue #151's whole point): a non-integer here means a malformed
  // state reached the bot layer without its RNG/seat wiring. Silently coercing
  // (`undefined >>> 0` → 0, `Math.imul(NaN, …)` → 0) would fabricate a
  // degenerate stream — and a NaN playerId would collapse the seed to rngState
  // itself, the exact mirror of the engine battle stream this offset prevents.
  if (!Number.isInteger(rngState) || !Number.isInteger(playerId)) {
    throw new TypeError(
      `deriveBotRandom: rngState and playerId must be integers, got ` +
        `rngState=${rngState}, playerId=${playerId}`
    );
  }
  const seed = ((rngState >>> 0) ^ Math.imul(playerId + 1, 0x9e3779b9)) >>> 0;
  return createRng(seed).nextFloat;
}
