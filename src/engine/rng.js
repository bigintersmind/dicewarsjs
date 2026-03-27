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
