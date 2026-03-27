import { createRng } from '../../src/engine/rng.js';

describe('createRng', () => {
  describe('determinism', () => {
    it('produces the same sequence from the same seed', () => {
      const a = createRng(42);
      const b = createRng(42);
      for (let i = 0; i < 100; i++) {
        expect(a.next()).toBe(b.next());
      }
    });

    it('produces different sequences from different seeds', () => {
      const a = createRng(1);
      const b = createRng(2);
      const valuesA = Array.from({ length: 10 }, () => a.next());
      const valuesB = Array.from({ length: 10 }, () => b.next());
      expect(valuesA).not.toEqual(valuesB);
    });
  });

  describe('next()', () => {
    it('returns values in [0, 1)', () => {
      const rng = createRng(123);
      for (let i = 0; i < 1000; i++) {
        const v = rng.next();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });
  });

  describe('nextInt(min, max)', () => {
    it('returns integers within the inclusive range', () => {
      const rng = createRng(99);
      for (let i = 0; i < 500; i++) {
        const v = rng.nextInt(3, 7);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(3);
        expect(v).toBeLessThanOrEqual(7);
      }
    });

    it('covers all values in the range', () => {
      const rng = createRng(77);
      const seen = new Set();
      for (let i = 0; i < 200; i++) {
        seen.add(rng.nextInt(1, 6));
      }
      expect(seen).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    });

    it('works when min equals max', () => {
      const rng = createRng(1);
      expect(rng.nextInt(5, 5)).toBe(5);
    });
  });

  describe('nextFloat()', () => {
    it('is an alias for next()', () => {
      const a = createRng(42);
      const b = createRng(42);
      for (let i = 0; i < 20; i++) {
        expect(a.nextFloat()).toBe(b.next());
      }
    });
  });

  describe('shuffle()', () => {
    it('is deterministic with the same seed', () => {
      const a = createRng(42);
      const b = createRng(42);
      const arr1 = [1, 2, 3, 4, 5, 6, 7, 8];
      const arr2 = [1, 2, 3, 4, 5, 6, 7, 8];
      a.shuffle(arr1);
      b.shuffle(arr2);
      expect(arr1).toEqual(arr2);
    });

    it('shuffles in place and returns the same array', () => {
      const rng = createRng(10);
      const arr = [1, 2, 3, 4, 5];
      const result = rng.shuffle(arr);
      expect(result).toBe(arr);
    });

    it('contains all original elements', () => {
      const rng = createRng(10);
      const arr = [10, 20, 30, 40, 50];
      rng.shuffle(arr);
      expect(arr.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    });

    it('actually reorders elements (not identity)', () => {
      const rng = createRng(42);
      const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const original = [...arr];
      rng.shuffle(arr);
      // With 10 elements the chance of no movement is negligible
      expect(arr).not.toEqual(original);
    });

    it('handles empty array', () => {
      const rng = createRng(1);
      const arr = [];
      rng.shuffle(arr);
      expect(arr).toEqual([]);
    });

    it('handles single-element array', () => {
      const rng = createRng(1);
      const arr = [42];
      rng.shuffle(arr);
      expect(arr).toEqual([42]);
    });
  });

  describe('state()', () => {
    it('returns the current state as a uint32', () => {
      const rng = createRng(42);
      const s = rng.state();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    });

    it('allows resuming from a saved state', () => {
      const rng1 = createRng(42);
      // Advance a few steps
      for (let i = 0; i < 10; i++) rng1.next();
      const savedState = rng1.state();

      // Continue generating from rng1
      const upcoming = Array.from({ length: 20 }, () => rng1.next());

      // Create rng2 from the saved state
      const rng2 = createRng(savedState);
      const replayed = Array.from({ length: 20 }, () => rng2.next());

      expect(replayed).toEqual(upcoming);
    });
  });

  describe('seed edge cases', () => {
    it('handles seed of 0', () => {
      const rng = createRng(0);
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    });

    it('handles large seed', () => {
      const rng = createRng(0xffffffff);
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    });

    it('throws RangeError when min > max', () => {
      const rng = createRng(1);
      expect(() => rng.nextInt(5, 1)).toThrow(RangeError);
      expect(() => rng.nextInt(5, 1)).toThrow(/min.*5.*max.*1/);
    });

    it('handles negative seed by coercing to uint32', () => {
      const rng = createRng(-1);
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      // -1 >>> 0 === 0xFFFFFFFF
      const rng2 = createRng(0xffffffff);
      const v2 = rng2.next();
      expect(v).toBe(v2);
    });
  });
});
