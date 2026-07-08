/**
 * Tests for Strategist AI implementation
 */
import { ai_strategist, winProbability } from '../../src/ai/ai_strategist.js';
import { MAX_DICE } from '../../src/ai/diceOdds.js';

describe('Strategist AI', () => {
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
      mockGame.player[i] = {
        area_c: 0,
        dice_c: 0,
        area_tc: 0,
        dice_jun: 0,
        stock: 0,
      };
    }

    for (let i = 0; i < mockGame.AREA_MAX; i++) {
      mockGame.adat[i] = {
        size: 0,
        arm: 0,
        dice: 0,
        join: Array(32).fill(0),
      };
    }
  });

  describe('winProbability', () => {
    test('matches known exact values', () => {
      // 2 dice vs 1 die: classic 0.8380
      expect(winProbability(2, 1)).toBeCloseTo(0.8379, 3);
      // 1v1: attacker must strictly exceed -> 15/36
      expect(winProbability(1, 1)).toBeCloseTo(15 / 36, 6);
    });

    test('ties favor the defender (equal dice below 50%)', () => {
      for (let n = 1; n <= 8; n++) {
        expect(winProbability(n, n)).toBeLessThan(0.5);
      }
    });

    test('8 dice always beat 1 die', () => {
      /*
       * Minimum sum of 8 dice (8) exceeds maximum of 1 die (6).
       * Convolution accumulates float error, so compare with tolerance.
       */
      expect(winProbability(8, 1)).toBeCloseTo(1, 12);
    });

    test('is monotonic in attacker dice', () => {
      for (let d = 1; d <= 8; d++) {
        for (let a = 2; a <= 8; a++) {
          // Allow float-precision ties where both sides saturate near 1
          expect(winProbability(a, d)).toBeGreaterThanOrEqual(winProbability(a - 1, d));
        }
      }
      // Strict increase where probabilities are not saturated
      expect(winProbability(3, 2)).toBeGreaterThan(winProbability(2, 2));
      expect(winProbability(5, 4)).toBeGreaterThan(winProbability(4, 4));
    });

    test('returns 0 for invalid dice counts', () => {
      expect(winProbability(0, 3)).toBe(0);
      expect(winProbability(3, 0)).toBe(0);
    });
  });

  test('ends turn when no valid moves are available', () => {
    territory(1, 1, 1); // Own territory with only 1 die cannot attack

    const result = ai_strategist(mockGame);

    expect(result).toBe(0);
    expect(mockGame.area_from).toBe(0);
    expect(mockGame.area_to).toBe(0);
  });

  test('ends turn when player has no territories', () => {
    territory(1, 2, 3);
    territory(2, 3, 2);
    link(1, 2);

    expect(ai_strategist(mockGame)).toBe(0);
  });

  test('attacks with a clear dice advantage', () => {
    territory(1, 1, 4);
    territory(2, 2, 1);
    territory(3, 2, 1); // Second enemy territory so no elimination bonus skews it
    link(1, 2);

    const result = ai_strategist(mockGame);

    expect(result).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('declines a disadvantaged attack', () => {
    territory(1, 1, 2);
    territory(2, 2, 4); // Defender is stronger
    territory(3, 2, 4);
    link(1, 2);
    link(2, 3);

    const result = ai_strategist(mockGame);

    expect(result).toBe(0);
  });

  test('prefers eliminating a player over an equivalent attack', () => {
    territory(1, 1, 4); // My attacker
    territory(2, 2, 2); // Player 2's only territory -> elimination
    territory(3, 3, 2); // Player 3 holds two territories
    territory(4, 3, 2);
    link(1, 2);
    link(1, 3);
    link(3, 4);

    ai_strategist(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('prefers cutting the enemy largest group at an articulation point', () => {
    territory(1, 1, 4); // My attacker
    // Enemy chain 2-3-4: territory 3 is the articulation point
    territory(2, 2, 2);
    territory(3, 2, 2);
    territory(4, 2, 2);
    link(2, 3);
    link(3, 4);
    link(1, 3); // Can hit the cut point...
    link(1, 4); // ...or the chain end

    ai_strategist(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3); // The cut, not the end
  });

  test('prefers a capture that merges its own groups', () => {
    // My two disconnected territories 1 and 2; capturing 3 bridges them
    territory(1, 1, 4);
    territory(2, 1, 1);
    territory(3, 2, 1); // Bridge cell
    territory(4, 2, 1); // Plain cell, same owner and dice
    link(1, 3);
    link(2, 3);
    link(1, 4);

    ai_strategist(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3); // The bridge, not the plain cell
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
    ai_strategist(mockGame);
    const firstMove = { from: mockGame.area_from, to: mockGame.area_to };

    // Fresh identical game
    mockGame.area_from = 0;
    mockGame.area_to = 0;
    ai_strategist(mockGame);

    expect(mockGame.area_from).toBe(firstMove.from);
    expect(mockGame.area_to).toBe(firstMove.to);
  });

  describe('bank-aware endgame aggression', () => {
    /*
     * Shared all-8s stalemate: player 1 (me) trails the leader (player 0) and
     * its ONLY legal attack is an 8v8 into the leader. Extra players are placed
     * away from player 1 purely to set the active-player count.
     */
    const buildStalemate = () => {
      territory(1, 0, 8); // leader
      territory(2, 0, 8);
      territory(3, 0, 8);
      territory(4, 1, 8); // me
      territory(5, 1, 8);
      link(1, 2);
      link(2, 3);
      link(4, 5);
      link(4, 1); // my only enemy border: an 8v8 into the leader
      mockGame.player[1].stock = 16; // a full reserve to spend
    };

    test('spends its reserve to chip the leader once the field has narrowed', () => {
      buildStalemate();
      territory(6, 2, 8); // third player -> 3 active, endgame gate open
      link(6, 3);

      const result = ai_strategist(mockGame);

      expect(result).not.toBe(0);
      expect(mockGame.area_from).toBe(4);
      expect(mockGame.adat[mockGame.area_to].arm).toBe(0); // attacked the leader
    });

    test('stays patient at the same all-8s board while many players are alive', () => {
      buildStalemate();
      territory(6, 2, 8); // four active players -> endgame gate closed
      territory(7, 3, 8);
      link(6, 3);
      link(7, 3);

      /*
       * Same reserve, same lone 8v8 into the leader, but the field is too wide:
       * patient play is stronger here, so it should not burn the attack.
       */
      expect(ai_strategist(mockGame)).toBe(0);
    });

    /*
     * Board that exercises the disruption *fallback* specifically (distinct from
     * the main attack path tested above). My only move is a 6v6 into the leader
     * (area 1), whose target is recaptureable by two backing 8-die cells, and I
     * hold six 1-die cells whose vacancy thins the refill discount. The result is
     * a leader swing that scores *below* the normal attack threshold — so the
     * main path declines (it would turtle) — yet stays above DISRUPT_THRESHOLD,
     * so only the trailing-leader fallback can produce this attack.
     */
    const buildFallbackBoard = stock => {
      territory(1, 0, 6); // leader's target cell, recaptureable by areas 2 and 3
      territory(2, 0, 8);
      territory(3, 0, 8);
      territory(4, 1, 6); // my attacker: a 6v6 into the leader (p = 0.467)
      for (let i = 10; i < 16; i++) territory(i, 1, 1); // vacancy thins the refill discount
      territory(6, 2, 5); // third player -> 3 active, endgame gate open
      link(1, 2);
      link(1, 3);
      link(2, 3);
      link(4, 1); // my ONLY legal attack
      link(6, 3);
      mockGame.player[1].stock = stock;
    };

    test('falls back to a sub-threshold swing at the leader rather than turtling', () => {
      buildFallbackBoard(MAX_DICE); // full-enough reserve -> disruptActive

      const result = ai_strategist(mockGame);

      /*
       * The main path's best score is below threshold here, so without the
       * fallback the bot would end its turn; instead it attacks the leader.
       */
      expect(result).not.toBe(0);
      expect(mockGame.area_from).toBe(4);
      expect(mockGame.adat[mockGame.area_to].arm).toBe(0); // the leader
    });

    test('fortifies instead of swinging when the reserve is below the bank threshold', () => {
      buildFallbackBoard(MAX_DICE - 1); // one die short of DISRUPT_MIN_BANK

      /*
       * Same board, same lone sub-threshold leader swing, but the reserve no
       * longer clears DISRUPT_MIN_BANK, so disruption is off and the bot fortifies.
       */
      expect(ai_strategist(mockGame)).toBe(0);
    });
  });

  test('only proposes legal attacks on a mixed board', () => {
    territory(1, 1, 3);
    territory(2, 1, 2);
    territory(3, 2, 2);
    territory(4, 3, 1);
    territory(5, 2, 8);
    link(1, 3);
    link(2, 4);
    link(3, 5);
    link(1, 2);

    const result = ai_strategist(mockGame);

    if (result !== 0) {
      const from = mockGame.adat[mockGame.area_from];
      const to = mockGame.adat[mockGame.area_to];
      expect(from.arm).toBe(1); // Attacks from own territory
      expect(from.dice).toBeGreaterThan(1); // With more than 1 die
      expect(to.arm).not.toBe(1); // Against an enemy
      expect(from.join[mockGame.area_to]).toBe(1); // That is adjacent
    }
  });

  describe('press-to-close refill for a dominant wide-field leader (issue #115)', () => {
    /*
     * All-8s frontier with FIVE players alive — the ≤3-player endgame gate
     * (PR #35) is closed. Me (player 1): strict dice lead, ≥40% share, full
     * reserve; my only legal attack is an 8v8 whose target is backed by two
     * rival 8-stacks. Without the dominance refund the burned-dice cost prices
     * that swing below PRESS_THRESHOLD and the leader turtles; with the
     * refund, the reserve makes it affordable.
     */
    const buildDominantStalemate = () => {
      // My chain: 5 cells, all 8s (40 dice) — vacancy 0, so the refill covers a swing fully.
      territory(4, 1, 8);
      territory(5, 1, 8);
      territory(10, 1, 8);
      territory(11, 1, 8);
      territory(12, 1, 8);
      link(4, 5);
      link(5, 10);
      link(10, 11);
      link(11, 12);
      // Best rival (player 0): a triangle of 8s (24 dice); cells 2 and 3 back cell 1.
      territory(1, 0, 8);
      territory(2, 0, 8);
      territory(3, 0, 8);
      link(1, 2);
      link(2, 3);
      link(1, 3);
      // Filler rivals away from my border → 5 active players, endgame gate closed.
      territory(6, 2, 8);
      territory(7, 2, 8);
      link(6, 7);
      link(6, 3);
      territory(8, 3, 8);
      link(8, 3);
      territory(9, 4, 8);
      link(9, 3);
      // My single enemy border: the 8v8 into the rival triangle.
      link(4, 1);
      mockGame.player[1].stock = 16; // a full reserve to spend
    };

    test('spends the reserve to press an 8v8 when dominant, even in a wide field', () => {
      buildDominantStalemate();
      // Census: me 40 dice (share ≈ 0.417 ≥ DOMINANCE_SHARE), best rival 24.

      const result = ai_strategist(mockGame);

      expect(result).not.toBe(0);
      expect(mockGame.area_from).toBe(4);
      expect(mockGame.area_to).toBe(1);
    });

    test('stays patient on the same board without the dominant share', () => {
      buildDominantStalemate();
      // Two extra far-rival stacks drop my share to 40/112 ≈ 0.357 < 0.4 while
      // I still hold the strict dice lead (40 > 32) → the refund must stay off.
      territory(13, 2, 8);
      territory(14, 2, 8);
      link(13, 14);
      link(13, 6);

      expect(ai_strategist(mockGame)).toBe(0);
    });
  });
});
