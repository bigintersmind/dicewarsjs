/**
 * Tests for the shared dice pip layout helper.
 */
import { getPipPositions } from '../../src/renderer/dicePips.js';

describe('getPipPositions', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
    [6, 6],
  ])('returns %i pips for value %i', (value, expectedCount) => {
    expect(getPipPositions(value, 4)).toHaveLength(expectedCount);
  });

  it('scales pip offsets by spacing', () => {
    const spacing = 10;
    const pips = getPipPositions(4, spacing);
    for (const [px, py] of pips) {
      expect(Math.abs(px)).toBe(spacing);
      expect(Math.abs(py)).toBe(spacing);
    }
  });

  it('centers the single pip for value 1', () => {
    expect(getPipPositions(1, 7)).toEqual([[0, 0]]);
  });

  it('falls back to a single centered pip for unknown values', () => {
    expect(getPipPositions(0, 5)).toEqual([[0, 0]]);
    expect(getPipPositions(7, 5)).toEqual([[0, 0]]);
    expect(getPipPositions(undefined, 5)).toEqual([[0, 0]]);
  });

  it('returns symmetric layouts (pips sum to center)', () => {
    for (let value = 1; value <= 6; value++) {
      const pips = getPipPositions(value, 3);
      const sumX = pips.reduce((acc, [px]) => acc + px, 0);
      const sumY = pips.reduce((acc, [, py]) => acc + py, 0);
      expect(sumX).toBe(0);
      expect(sumY).toBe(0);
    }
  });
});
