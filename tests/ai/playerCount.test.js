import { getPlayerCount } from '../../src/ai/playerCount.js';

/*
 * getPlayerCount reads only three fields of a legacy game view: player[] (for
 * its length), adat[] (1-indexed board areas, each { size, arm }), and
 * AREA_MAX. It returns the largest of player.length, one-past-the-highest board
 * owner index, and a floor of 8. These cases pin each branch directly — the
 * 9-player integration test in tests/arena/legacyBotAdapter.test.js exercises
 * the fix end-to-end but cannot reach the board-scan branch (there player.length
 * already equals the owner count), so this is where that logic is guarded.
 */

// area { size, arm }: size !== 0 means occupied; arm is the owner's player index.
const occupied = arm => ({ size: 1, arm });
const empty = arm => ({ size: 0, arm }); // a vacated/sentinel area (arm ignored)

describe('getPlayerCount', () => {
  it('returns player.length when it dominates the board owner count', () => {
    const game = {
      player: Array(9).fill(null),
      AREA_MAX: 4,
      adat: [null, occupied(0), occupied(1), occupied(2)],
    };
    expect(getPlayerCount(game)).toBe(9);
  });

  it('returns one past the highest board owner index when it exceeds player.length', () => {
    // The regression-critical branch: player[] is shorter than the board needs.
    const game = {
      player: Array(8).fill(null),
      AREA_MAX: 3,
      adat: [null, occupied(9), occupied(2)],
    };
    expect(getPlayerCount(game)).toBe(10);
  });

  it('falls back to the floor of 8 when both inputs are smaller', () => {
    const game = {
      player: Array(4).fill(null),
      AREA_MAX: 3,
      adat: [null, occupied(0), occupied(1)],
    };
    expect(getPlayerCount(game)).toBe(8);
  });

  it('treats a missing player[] as length 0 (still floored to 8)', () => {
    const game = {
      AREA_MAX: 3,
      adat: [null, occupied(0), occupied(1)],
    };
    expect(getPlayerCount(game)).toBe(8);
  });

  it('ignores empty/sentinel areas and tolerates holes in adat', () => {
    /*
     * adat[1] is vacated (size 0) with a high arm that must NOT count; index 2
     * is a hole (undefined); the real owners are at indices 10 and 3.
     */
    const game = {
      player: Array(8).fill(null),
      AREA_MAX: 6,
      adat: [null, empty(99), undefined, occupied(10), null, occupied(3)],
    };
    expect(getPlayerCount(game)).toBe(11);
  });

  it('does not throw when the board (adat) is absent from a partial view', () => {
    const game = { player: Array(9).fill(null), AREA_MAX: 5 };
    expect(() => getPlayerCount(game)).not.toThrow();
    expect(getPlayerCount(game)).toBe(9);
  });
});
