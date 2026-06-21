/**
 * Tests for the Expectimax AI (chance-node search baseline).
 *
 * Mirrors the legacy-view test harness used by ai_strategist: a mutable
 * `game` with an `adat` territory table, `get_pn()`, and `area_from/area_to`
 * set in place by the bot.
 */
import { ai_expectimax } from '../../src/ai/ai_expectimax.js';

describe('Expectimax AI', () => {
  let mockGame;

  /** Symmetrically connect two territories */
  const link = (a, b) => {
    mockGame.adat[a].join[b] = 1;
    mockGame.adat[b].join[a] = 1;
  };

  /** Create a territory with owner and dice */
  const territory = (id, arm, dice) => {
    mockGame.adat[id].size = 10;
    mockGame.adat[id].arm = arm;
    mockGame.adat[id].dice = dice;
  };

  beforeEach(() => {
    mockGame = {
      AREA_MAX: 32,
      adat: [],
      area_from: 0,
      area_to: 0,
      jun: [0, 1, 2, 3, 4, 5, 6, 7],
      ban: 1, // Current turn is player 1
      player: [],
      get_pn() {
        return this.jun[this.ban];
      },
    };

    for (let i = 0; i < 8; i++) {
      mockGame.player[i] = { area_c: 0, dice_c: 0, area_tc: 0, dice_jun: 0, stock: 0 };
    }

    for (let i = 0; i < mockGame.AREA_MAX; i++) {
      mockGame.adat[i] = { size: 0, arm: 0, dice: 0, join: Array(32).fill(0) };
    }
  });

  test('ends turn when no valid moves are available', () => {
    territory(1, 1, 1); // Own territory with only 1 die cannot attack

    const result = ai_expectimax(mockGame);

    expect(result).toBe(0);
    expect(mockGame.area_from).toBe(0);
    expect(mockGame.area_to).toBe(0);
  });

  test('ends turn when player has no territories', () => {
    territory(1, 2, 3);
    territory(2, 3, 2);
    link(1, 2);

    expect(ai_expectimax(mockGame)).toBe(0);
  });

  test('attacks with a clear dice advantage', () => {
    territory(1, 1, 4);
    territory(2, 2, 1);
    territory(3, 2, 1); // Second enemy territory so no elimination skews it
    link(1, 2);

    const result = ai_expectimax(mockGame);

    expect(result).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('declines a clearly disadvantaged attack', () => {
    territory(1, 1, 2);
    territory(2, 2, 5); // Defender much stronger
    territory(3, 2, 5);
    link(1, 2);
    link(2, 3);

    const result = ai_expectimax(mockGame);

    expect(result).toBe(0);
  });

  test('proposes only legal attacks on a mixed board', () => {
    territory(1, 1, 3);
    territory(2, 1, 2);
    territory(3, 2, 2);
    territory(4, 3, 1);
    territory(5, 2, 8);
    link(1, 3);
    link(2, 4);
    link(3, 5);
    link(1, 2);

    const result = ai_expectimax(mockGame);

    if (result !== 0) {
      const from = mockGame.adat[mockGame.area_from];
      const to = mockGame.adat[mockGame.area_to];
      expect(from.arm).toBe(1); // Attacks from own territory
      expect(from.dice).toBeGreaterThan(1); // With more than 1 die
      expect(to.arm).not.toBe(1); // Against an enemy
      expect(from.join[mockGame.area_to]).toBe(1); // That is adjacent
    }
  });

  test('plans a deeper combo than a one-ply scorer would (depth-2 differentiator)', () => {
    /*
     * Same board as the legality test above, chosen because it is a verified
     * depth divergence and guards the bot's headline lookahead: a greedy
     * one-ply scorer takes 2->4, but the depth-2 search prefers 1->3 (capturing
     * area 3 opens a profitable continuation a one-ply scorer cannot see).
     * Verified to flip to 2->4 when SEARCH_DEPTH is reduced to 1, so this
     * assertion fails if the search silently collapses to greedy.
     */
    territory(1, 1, 3);
    territory(2, 1, 2);
    territory(3, 2, 2);
    territory(4, 3, 1);
    territory(5, 2, 8);
    link(1, 3);
    link(2, 4);
    link(3, 5);
    link(1, 2);

    ai_expectimax(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3);
  });

  test('prefers a near-certain elimination over a coin-flip non-cutting fight', () => {
    territory(1, 1, 8); // My strong attacker
    territory(2, 2, 1); // Player 2's only territory -> trivial 8v1 elimination
    territory(3, 3, 8); // Player 3 cell: an 8v8 coin flip, and isolated...
    territory(4, 3, 1); // ...Player 3's other cell is not adjacent (no group to cut)
    link(1, 2);
    link(1, 3);

    ai_expectimax(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('is deterministic for identical states', () => {
    const setup = game => {
      const t = (id, arm, dice) => {
        game.adat[id].size = 10;
        game.adat[id].arm = arm;
        game.adat[id].dice = dice;
      };
      const l = (a, b) => {
        game.adat[a].join[b] = 1;
        game.adat[b].join[a] = 1;
      };
      t(1, 1, 5);
      t(2, 1, 3);
      t(3, 2, 2);
      t(4, 2, 2);
      t(5, 3, 3);
      l(1, 3);
      l(2, 4);
      l(3, 4);
      l(4, 5);
      l(1, 5);
    };

    setup(mockGame);
    ai_expectimax(mockGame);
    const firstMove = { from: mockGame.area_from, to: mockGame.area_to };

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    ai_expectimax(mockGame);

    expect(mockGame.area_from).toBe(firstMove.from);
    expect(mockGame.area_to).toBe(firstMove.to);
  });
});
