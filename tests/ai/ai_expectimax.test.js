/**
 * Tests for the Expectimax AI (chance-node search baseline).
 *
 * Mirrors the legacy-view test harness used by ai_strategist: a mutable
 * `game` with an `adat` territory table, `get_pn()`, and `area_from/area_to`
 * set in place by the bot.
 */
import { ai_expectimax, makeExpectimax } from '../../src/ai/ai_expectimax.js';

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
     * Verified to flip to 2->4 when searchDepth is reduced to 1
     * (makeExpectimax({ searchDepth: 1 }) — see the dedicated test below), so
     * this assertion fails if the search silently collapses to greedy.
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
     *
     * Built with an explicit low `attackThreshold` (not the shipped default): with
     * the Phase-0-tuned `threat: 2.0`, both single-cell 2v1 captures here are
     * deliberately marginal (each exposes a fresh 1-die cell to a counter), so the
     * shipped bot would correctly *decline both* — which can't isolate the
     * vulnerability term. Lowering only the threshold forces the choice while
     * keeping the shipped `threat` weight under test, so this guards the
     * vulnerability mechanic independently of how patient the production tuning is.
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

    makeExpectimax({ attackThreshold: 0.05 })(mockGame);

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

  test('makeExpectimax() with no overrides reproduces the shipped default bot', () => {
    /*
     * The PR claim that the shipped `ai_expectimax` is exactly `makeExpectimax()`
     * with DEFAULT_PARAMS. Guards the no-arg factory path against drift.
     */
    territory(1, 1, 4);
    territory(2, 2, 1);
    territory(3, 2, 1); // second enemy cell so the capture is not an elimination
    link(1, 2);

    ai_expectimax(mockGame);
    const shipped = { from: mockGame.area_from, to: mockGame.area_to };

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    makeExpectimax()(mockGame);

    expect(mockGame.area_from).toBe(shipped.from);
    expect(mockGame.area_to).toBe(shipped.to);
  });

  test('overriding one param keeps the other defaults (factory merges, not replaces)', () => {
    /*
     * The factory does `{ ...DEFAULT_PARAMS, ...params }`. If it instead did
     * `{ ...params }`, every unspecified weight would be undefined -> NaN scores
     * -> the bot would never clear the threshold and would return 0. Overriding
     * only `attackThreshold` and still landing a real attack proves the income/
     * territory/dice/threat defaults survived the merge.
     */
    territory(1, 1, 4);
    territory(2, 2, 1);
    territory(3, 2, 1);
    link(1, 2);

    const result = makeExpectimax({ attackThreshold: 0.05 })(mockGame);

    expect(result).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('rejects an unknown or non-finite param (fail-fast config guard)', () => {
    /*
     * A typo'd key would otherwise be silently dropped and the sweep would
     * re-test the defaults while appearing to test the candidate.
     */
    expect(() => makeExpectimax({ attackThreshhold: 0.5 })).toThrow(/unknown param/);
    expect(() => makeExpectimax({ threat: NaN })).toThrow(/finite number/);
  });

  /*
   * Posture-adaptive threshold — the D-8 press-mechanism. Each test below pins a
   * board into one of the three postures (by dice share / rival count) and proves
   * the corresponding threshold is the lever that flips decline->attack, while the
   * other two thresholds are set to extremes so a *mis-selected* posture would give
   * the wrong answer. Pinned to explicit params (not the shipped defaults), so the
   * mechanism stays under test independently of how the production weights are tuned.
   */

  /** Balanced board: my dice share ≈ 0.29, two rivals → BASE posture. */
  const balancedBoard = () => {
    territory(1, 1, 4); // my attacker
    territory(2, 1, 2); // my other cell
    territory(3, 2, 1); // a near-certain 4v1 capture (modest, ~+1 EV gain)
    territory(4, 2, 4);
    territory(5, 2, 3);
    territory(6, 3, 4);
    territory(7, 3, 3);
    link(1, 3);
    link(3, 4); // captured cell backs onto a live enemy → modest, not free
    link(4, 5);
    link(2, 6);
    link(6, 7);
  };

  /*
   * Dominant board: my dice share ≈ 0.70 → PRESS posture. Two rivals on purpose,
   * so the heads-up-duel press shortcut (activeRivals === 1) does NOT fire and the
   * press posture is selected by dice share alone — which the pressDiceShare-gating
   * test below relies on to isolate the share cutoff.
   */
  const dominantBoard = () => {
    territory(1, 1, 3); // my attacker (a 3v3 coin-flip, marginal EV)
    territory(2, 1, 8);
    territory(3, 1, 8); // lots of my dice → dominant
    territory(4, 2, 3);
    territory(5, 2, 2);
    territory(6, 3, 2);
    territory(7, 3, 1);
    link(1, 4);
    link(4, 5);
    link(5, 6);
    link(6, 7);
  };

  /** Weak board: my dice share ≈ 0.10, two strong rivals → WEAK posture. */
  const weakBoard = () => {
    territory(1, 1, 4); // my attacker
    territory(2, 1, 1);
    territory(3, 2, 1); // a near-certain 4v1 capture (~+0.6 EV gain)
    territory(4, 2, 8);
    territory(5, 2, 6);
    territory(6, 2, 8);
    territory(7, 3, 8);
    territory(8, 3, 6);
    territory(9, 3, 8);
    link(1, 3);
    link(3, 4);
    link(4, 5);
    link(5, 6);
    link(7, 8);
    link(8, 9);
    link(2, 7);
  };

  test('BASE posture: a balanced game uses baseThreshold (patience)', () => {
    // press/weak pinned low: a mis-selected posture would attack in BOTH cases.
    balancedBoard();
    expect(
      makeExpectimax({ baseThreshold: 0.5, pressThreshold: -50, weakThreshold: -50 })(mockGame)
    ).not.toBe(0);
    expect(mockGame.area_to).toBe(3);

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    balancedBoard();
    expect(
      makeExpectimax({ baseThreshold: 2.0, pressThreshold: -50, weakThreshold: -50 })(mockGame)
    ).toBe(0);
    expect(mockGame.area_from).toBe(0);
  });

  test('PRESS posture: a dominant board uses pressThreshold (close out a won game)', () => {
    /*
     * base/weak pinned high: a mis-selected posture would decline in BOTH cases.
     * The capture is a 3v3 coin flip, so the risk floor is disabled (lowOddsPenalty: 0)
     * to isolate the posture threshold from it.
     */
    dominantBoard();
    expect(
      makeExpectimax({
        pressThreshold: -2,
        baseThreshold: 50,
        weakThreshold: 50,
        lowOddsPenalty: 0,
      })(mockGame)
    ).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(4);

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    dominantBoard();
    expect(
      makeExpectimax({
        pressThreshold: 2,
        baseThreshold: 50,
        weakThreshold: 50,
        lowOddsPenalty: 0,
      })(mockGame)
    ).toBe(0);
    expect(mockGame.area_from).toBe(0);
  });

  test('WEAK posture: losing badly in a crowd uses weakThreshold (claw back)', () => {
    // press/base pinned high: a mis-selected posture would decline in BOTH cases.
    weakBoard();
    expect(
      makeExpectimax({ weakThreshold: 0.3, pressThreshold: 50, baseThreshold: 50 })(mockGame)
    ).not.toBe(0);
    expect(mockGame.area_to).toBe(3);

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    weakBoard();
    expect(
      makeExpectimax({ weakThreshold: 1.2, pressThreshold: 50, baseThreshold: 50 })(mockGame)
    ).toBe(0);
    expect(mockGame.area_from).toBe(0);
  });

  test('WEAK posture requires >1 rival (a single dominant rival stays BASE)', () => {
    /*
     * Guards the `activeRivals > 1` half of the WEAK condition. Two boards identical
     * except for how the dominant enemy dice are split: one player vs two. My share is
     * ~0.11 (below weakDiceShare) in BOTH, and I never lead, so the only thing that can
     * select WEAK is the rival count. weakThreshold is pinned low (would take the 4v1
     * capture) and base/press pinned high (would decline). A regression relaxing the
     * guard to `>= 1` would make the single-rival board claw back — exactly the wrong
     * posture in a 1v1 you are losing.
     */
    const cfg = { weakThreshold: 0.3, baseThreshold: 50, pressThreshold: 50, lowOddsPenalty: 0 };
    const losingBoard = splitRival => () => {
      territory(1, 1, 4); // my attacker — a near-certain 4v1 capture
      territory(2, 2, 1); // the capture target (owned by player 2)
      territory(3, 2, 8);
      territory(4, 2, 8);
      territory(5, splitRival ? 3 : 2, 8); // splitRival ⇒ a 2nd rival; else all player 2
      territory(6, splitRival ? 3 : 2, 8);
      link(1, 2);
    };

    // One dominant rival → guard blocks WEAK → falls to the steep BASE → decline.
    losingBoard(false)();
    expect(makeExpectimax(cfg)(mockGame)).toBe(0);
    expect(mockGame.area_from).toBe(0);

    // Same dice, split across two rivals → WEAK fires → the low bar takes the capture.
    mockGame.area_from = 0;
    mockGame.area_to = 0;
    losingBoard(true)();
    expect(makeExpectimax(cfg)(mockGame)).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('pressDiceShare gates the press posture (board dice-share selects the bar)', () => {
    /*
     * Same dominant board and same low pressThreshold both times; only the share
     * cutoff moves. At the default cutoff (0.38) my ≈0.70 share qualifies → PRESS →
     * the marginal capture clears the negative bar. Raise the cutoff above my share
     * (0.99) and I no longer qualify → BASE → the high baseThreshold declines it.
     * Isolates the posture *selector*, not the threshold values.
     */
    dominantBoard();
    expect(
      makeExpectimax({
        pressThreshold: -2,
        baseThreshold: 50,
        weakThreshold: 50,
        lowOddsPenalty: 0,
      })(mockGame)
    ).not.toBe(0);
    expect(mockGame.area_to).toBe(4);

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    dominantBoard();
    expect(
      makeExpectimax({
        pressThreshold: -2,
        baseThreshold: 50,
        weakThreshold: 50,
        pressDiceShare: 0.99,
        lowOddsPenalty: 0,
      })(mockGame)
    ).toBe(0);
    expect(mockGame.area_from).toBe(0);
  });

  test('pressDiceShare boundary is strict: a share exactly at the cutoff does NOT press', () => {
    /*
     * Pins the strict `>` in `myShare > pressDiceShare` (a `>=` regression would
     * silently press here). The board gives me exactly half the dice on the board
     * (4 of 8), and pressDiceShare is set to 0.5 to match. With the strict `>`,
     * 0.5 is NOT > 0.5 → not PRESS; two rivals keep the duel shortcut from firing
     * and WEAK can't fire (0.5 is not < weakDiceShare), so the bar falls to the
     * steep BASE and declines the capture. A relaxed `>=` would select PRESS and
     * take it. press pinned low / base+weak pinned high so posture is the only lever.
     */
    territory(1, 1, 4); // me: 4 dice — exactly half the board — my only attacker
    territory(2, 2, 1); // a near-certain 4v1 capture (player 2 survives via area 3)
    territory(3, 2, 1); // player 2's other cell → capturing area 2 is not an elimination
    territory(4, 3, 2); // a second rival → activeRivals === 2 (duel shortcut can't fire)
    link(1, 2);

    const result = makeExpectimax({
      pressThreshold: -50,
      baseThreshold: 50,
      weakThreshold: 50,
      pressDiceShare: 0.5,
      lowOddsPenalty: 0,
    })(mockGame);

    expect(result).toBe(0);
    expect(mockGame.area_from).toBe(0);
  });

  /*
   * Heads-up-duel PRESS shortcut: PRESS is also selected by `activeRivals === 1 &&
   * diceByPlayer[me] > bestRivalDice` — the second half of the PRESS condition, which
   * none of the dominantBoard tests reach (that board uses two rivals on purpose). In a
   * true 1v1 a dice lead already pushes my share past pressDiceShare, so to isolate the
   * shortcut these tests raise pressDiceShare to 0.99 — above my ~0.86 share — so the
   * share clause CANNOT fire and only the duel shortcut can select PRESS. Note
   * `diceByPlayer`/`bestRivalDice` are per-player *totals*, not per-cell maxima.
   */
  const duelBoard = iLead => () => {
    territory(1, 1, 3); // my attacker — a marginal 3v3 coin flip vs the rival
    territory(2, 2, 3); // rival defender
    territory(3, 1, 8); // my dice elsewhere
    territory(4, iLead ? 1 : 2, 8); // mine ⇒ I lead the duel 19–3; rival's ⇒ totals tie 11–11
    link(1, 2);
  };

  test('PRESS shortcut: leading a heads-up duel presses even below pressDiceShare', () => {
    /*
     * pressDiceShare pinned at 0.99 (above my share) so the share clause is off; PRESS
     * can only come from the duel lead. base/weak pinned high so a mis-selected posture
     * declines. lowOddsPenalty off so the coin-flip's risk floor can't mask the result.
     */
    const cfg = {
      pressThreshold: -3,
      baseThreshold: 50,
      weakThreshold: 50,
      pressDiceShare: 0.99,
      lowOddsPenalty: 0,
    };

    // Leading the duel (19 vs 3 dice) → shortcut fires → PRESS takes the marginal capture.
    duelBoard(true)();
    expect(makeExpectimax(cfg)(mockGame)).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);

    /*
     * Same board, dice rebalanced to a tie (11 vs 11): `diceByPlayer[me] > bestRivalDice`
     * is now false (strict >), so the shortcut does NOT fire. Share is still below the
     * 0.99 cutoff and WEAK needs >1 rival, so the bar falls to the steep BASE → decline.
     * Pins the strict-greater boundary of the duel lead.
     */
    mockGame.area_from = 0;
    mockGame.area_to = 0;
    duelBoard(false)();
    expect(makeExpectimax(cfg)(mockGame)).toBe(0);
    expect(mockGame.area_from).toBe(0);
  });

  test('attackThreshold override disables posture adaptation (fixed bar)', () => {
    /*
     * Setting an explicit attackThreshold pins a single fixed bar regardless of
     * posture — the back-compat path the mechanic tests above (and the tuning
     * sweeps) rely on. On the dominant board a high fixed bar declines the same
     * marginal capture that the posture-adaptive default (PRESS) would take.
     */
    dominantBoard();
    expect(makeExpectimax({ attackThreshold: 50 })(mockGame)).toBe(0);
    expect(mockGame.area_from).toBe(0);

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    dominantBoard();
    expect(makeExpectimax({ attackThreshold: -50 })(mockGame)).not.toBe(0);
    expect(mockGame.area_to).toBe(4);
  });

  test('attackThreshold: null is accepted (selects posture-adaptive mode)', () => {
    // null is the sentinel for posture mode; it must not trip the finite-number guard.
    expect(() => makeExpectimax({ attackThreshold: null })).not.toThrow();
    /*
     * A dominant, near-certain 4v1 capture: posture mode (PRESS) takes it regardless
     * of the production threshold/risk tuning, so this stays a robust accept-the-sentinel check.
     */
    territory(1, 1, 4);
    territory(2, 2, 1);
    territory(3, 2, 1);
    link(1, 2);
    makeExpectimax({ attackThreshold: null })(mockGame);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('searchDepth is threaded through the factory (depth 2 plans the combo, depth 1 plays greedy)', () => {
    /*
     * Same board as the depth-2 combo test. Holding the eval weights, a low fixed
     * `attackThreshold` (so neither config declines), and the risk floor off
     * (`lowOddsPenalty: 0`, so it can't reshape the combo's odds math), the ONLY
     * varied input is `searchDepth` — proving the search-shape param flows through
     * the factory. Depth 2 sees the 1->3 combo; depth 1 is greedy (2->4).
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

    makeExpectimax({ searchDepth: 2, attackThreshold: 0.05, lowOddsPenalty: 0 })(mockGame);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3);

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    makeExpectimax({ searchDepth: 1, attackThreshold: 0.05, lowOddsPenalty: 0 })(mockGame);
    expect(mockGame.area_from).toBe(2);
    expect(mockGame.area_to).toBe(4);
  });

  test('lowOddsPenalty makes the bot decline a coin-flip it would otherwise gamble on (risk floor)', () => {
    /*
     * The risk floor (mirrors ai_lookahead's LOW_ODDS_PENALTY): pure EV would take
     * an even-money capture in a winning position, but the explicit floor docks
     * low-win-probability attacks so the bot avoids variance in a crowd. The
     * dominant board's only capture is a 3v3 coin flip (p ≈ 0.47, below the 0.78
     * floor). With the floor off the press posture gambles; with a steep floor the
     * same move is declined. pressThreshold is held fixed so the floor is the only
     * lever that flips the decision.
     */
    dominantBoard();
    expect(makeExpectimax({ lowOddsPenalty: 0, pressThreshold: -1 })(mockGame)).not.toBe(0);
    expect(mockGame.area_to).toBe(4);

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    dominantBoard();
    expect(
      makeExpectimax({ lowOddsFloor: 0.78, lowOddsPenalty: 20, pressThreshold: -1 })(mockGame)
    ).toBe(0);
    expect(mockGame.area_from).toBe(0);
  });

  test('the risk floor reorders the chosen move, not just attack-vs-stop', () => {
    /*
     * The test above runs on a single-attack board, so it only exercises the floor's
     * effect on the final accept/decline gate. This board offers TWO competing attacks
     * and pins a low fixed bar (attackThreshold: -50) so the bot always attacks — the
     * only observable is WHICH move it picks, isolating the floor's effect on the
     * candidate ranking (search() subtracts m.lowOdds from each move's value, not only
     * from the accept check). Depth 1 keeps it a clean one-ply leaf decision.
     *
     *   A (1->2): a 3v3 coin flip (p≈0.45) whose win eliminates rival 3 → high EV but
     *             low odds, so the floor docks it hard.
     *   B (5->6): a 4v1 near-certain capture (p≈0.997) of modest value → above the
     *             floor, essentially undocked.
     *
     * Floor off, A's higher EV wins; turn the floor on and A's low-odds penalty drops
     * it below B, so the bot switches to the safe capture. A regression that applied
     * the penalty to the accept gate but not to the per-move value would keep picking A.
     */
    const sortBoard = () => {
      territory(1, 1, 3); // attacker A — 3v3 coin flip
      territory(2, 3, 3); // rival 3's ONLY cell → winning A eliminates rival 3
      territory(5, 1, 4); // attacker B — 4v1
      territory(6, 2, 1); // capture target for B
      territory(7, 2, 5);
      territory(8, 2, 5); // rival 2 survives B
      link(1, 2);
      link(5, 6);
      link(6, 7);
      link(7, 8);
    };
    const cfg = pen => ({
      searchDepth: 1,
      attackThreshold: -50,
      lowOddsFloor: 0.78,
      lowOddsPenalty: pen,
    });

    // Floor off → the high-EV coin flip wins the ranking.
    sortBoard();
    expect(makeExpectimax(cfg(0))(mockGame)).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);

    // Floor on → the coin flip is penalized below the safe capture; the pick flips.
    mockGame.area_from = 0;
    mockGame.area_to = 0;
    sortBoard();
    expect(makeExpectimax(cfg(20))(mockGame)).not.toBe(0);
    expect(mockGame.area_from).toBe(5);
    expect(mockGame.area_to).toBe(6);
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
