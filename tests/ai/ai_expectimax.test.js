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

  test('prefers a safe near-certain capture over a coin-flip fight', () => {
    /*
     * The near-certain 8v1 (area 2) dominates the 8v8 coin-flip (area 3) on pure
     * capture EV alone — this guards the bot's risk discipline, not its
     * elimination logic. That area 2 is its owner's last cell is incidental; the
     * active-rival/elimination term is isolated separately below in "eliminates a
     * rival when the capture EV is otherwise equal".
     */
    territory(1, 1, 8); // My strong attacker
    territory(2, 2, 1); // A near-certain 8v1 capture
    territory(3, 3, 8); // vs an 8v8 coin flip...
    territory(4, 3, 1); // ...whose owner has another, non-adjacent cell
    link(1, 2);
    link(1, 3);

    ai_expectimax(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('prefers a bridge capture that merges two groups (win-board income term)', () => {
    /*
     * Single attacker (area 1, 4 dice) with two equal near-certain 4v1 captures:
     * area 4 BRIDGES my two isolated cells (1 and 2) into one group of 3, while
     * area 3 is a dead-end capture leaving my largest group at 2. Personal gains
     * (territory, dice), exposure, and rival terms are identical between the two;
     * the ONLY differing input is my largest connected group on the win board, so
     * this isolates the INCOME/largest-group term in evaluateBoard.
     *
     * Layout is chosen so the WRONG choice (dead-end, area 3) is the lower index:
     * if the income term were ignored the two captures tie and the index
     * tie-break would pick area 3, so asserting area 4 genuinely exercises income.
     * Area 2 has 1 die so it cannot attack — no second-ply merge can skew it.
     */
    territory(1, 1, 4); // my only attacker
    territory(2, 1, 1); // my other cell (isolated from 1; cannot attack)
    territory(3, 2, 1); // dead-end: adjacent to 1 only (lower index = tie-break default)
    territory(4, 2, 1); // bridge: adjacent to both 1 and 2
    link(1, 3);
    link(1, 4);
    link(2, 4);

    ai_expectimax(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(4);
  });

  test('prefers the capture that leaves a safer border (enemy-perspective vulnerability)', () => {
    /*
     * Single attacker (area 1, 2 dice) with two equal 2v1 captures. Capturing
     * area 2 backs my new cell onto a strong enemy (area 4, 8 dice); capturing
     * area 3 backs onto a weak enemy (area 5, 2 dice). Personal gains and rival
     * terms are identical; only the post-capture border exposure differs, so this
     * pins the vulnerability term's orientation: WIN_TABLE[enemyDice][myDice] (the
     * enemy's odds against my cell), not the reverse. The 8-dice neighbor also
     * exercises the clampDie/MAX_DICE boundary.
     *
     * Captured cells end at 1 die (cannot counter-attack), so no second-ply bonus
     * confounds the comparison. The safe choice (area 3) is the HIGHER index, so a
     * reversed index — WIN_TABLE[8][1]=1 becomes WIN_TABLE[1][8]=0 — would zero
     * both exposures and the tie-break would (wrongly) pick area 2, failing this.
     */
    territory(1, 1, 2); // my only attacker
    territory(2, 2, 1); // capture backs onto a strong enemy (area 4) — exposed
    territory(3, 2, 1); // capture backs onto a weak enemy (area 5) — safer
    territory(4, 3, 8); // strong threat behind area 2
    territory(5, 3, 2); // weak threat behind area 3
    link(1, 2);
    link(1, 3);
    link(2, 4);
    link(3, 5);

    ai_expectimax(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3);
  });

  test('eliminates a rival when the capture EV is otherwise equal (active-rival term)', () => {
    /*
     * Single attacker (area 1, 8 dice) with two equal 8v2 captures. Capturing
     * area 3 removes player 2 from the board (its only cell); capturing area 2
     * leaves every player alive. Win probability, personal gain (territory, dice,
     * largest group), post-capture exposure, and best-rival income are all
     * identical between the two — the ONLY differing input is the active-rival
     * count, so this isolates the elimination term.
     *
     * The eliminating move (area 3) is the HIGHER index, so if the active-rival
     * term were ignored the two captures tie and the tie-break would (wrongly)
     * pick area 2 — asserting area 3 genuinely exercises the elimination term.
     * Player 3's second cell (area 4) is walled off, so no second-ply elimination
     * can skew it.
     */
    territory(1, 1, 8); // my only attacker
    territory(2, 3, 2); // player 3 survives this capture (still owns area 4)
    territory(3, 2, 2); // player 2's ONLY cell -> capturing eliminates player 2
    territory(4, 3, 1); // player 3's other cell, walled off behind area 5
    territory(5, 4, 1); // neutral wall so area 4 is unreachable from my cells
    link(1, 2);
    link(1, 3);
    link(4, 5);

    ai_expectimax(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3);
  });

  test('plays a legal move as the highest-indexed player in a 9-player game', () => {
    /*
     * The online tournament seats more than 8 players, so the bot must handle
     * being player 8 — an owner index past the usual 8 slots. getPlayerCount
     * sizes the census to one past the highest board owner (9 here) even though
     * player[] holds only 8 entries, so evaluateBoard's per-player arrays must
     * cover index 8 without going out of bounds. Guards that sizing path for the
     * highest-indexed seat (a config unit board tests otherwise never exercise).
     */
    mockGame.jun = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    mockGame.ban = 8; // get_pn() -> 8
    territory(1, 8, 5); // my cell (player 8)
    territory(2, 2, 1); // weak enemy, a near-certain capture
    territory(3, 2, 1); // second enemy cell so the capture is not an elimination
    link(1, 2);

    expect(() => ai_expectimax(mockGame)).not.toThrow();
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
