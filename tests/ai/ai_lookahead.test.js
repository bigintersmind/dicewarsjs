/**
 * Tests for Lookahead AI implementation
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ai_lookahead, winProbability, evaluateLookaheadTurn } from '../../src/ai/ai_lookahead.js';
import * as lookaheadModule from '../../src/ai/ai_lookahead.js';

describe('Lookahead AI', () => {
  let mockGame;

  const link = (a, b) => {
    mockGame.adat[a].join[b] = 1;
    mockGame.adat[b].join[a] = 1;
  };

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
      ban: 1,
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
        join: Array(mockGame.AREA_MAX).fill(0),
      };
    }
  });

  describe('winProbability', () => {
    test('matches known exact values', () => {
      expect(winProbability(2, 1)).toBeCloseTo(0.8379, 3);
      expect(winProbability(1, 1)).toBeCloseTo(15 / 36, 6);
      expect(winProbability(8, 1)).toBeCloseTo(1, 12);
    });

    test('is monotonic in attacker dice', () => {
      for (let defender = 1; defender <= 8; defender++) {
        for (let attacker = 2; attacker <= 8; attacker++) {
          expect(winProbability(attacker, defender)).toBeGreaterThanOrEqual(
            winProbability(attacker - 1, defender)
          );
        }
      }
    });

    test('returns 0 for invalid dice counts', () => {
      expect(winProbability(0, 3)).toBe(0);
      expect(winProbability(3, 0)).toBe(0);
    });
  });

  test('ends turn when no valid moves are available', () => {
    territory(1, 1, 1);

    expect(ai_lookahead(mockGame)).toBe(0);
    expect(mockGame.area_from).toBe(0);
    expect(mockGame.area_to).toBe(0);
  });

  test('ends turn when player has no territories', () => {
    territory(1, 2, 3);
    territory(2, 3, 2);
    link(1, 2);

    expect(ai_lookahead(mockGame)).toBe(0);
  });

  test('attacks with a clear dice advantage', () => {
    territory(1, 1, 5);
    territory(2, 2, 1);
    territory(3, 2, 1);
    link(1, 2);

    expect(ai_lookahead(mockGame)).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('declines a disadvantaged attack', () => {
    territory(1, 1, 2);
    territory(2, 2, 5);
    territory(3, 2, 4);
    link(1, 2);
    link(2, 3);

    expect(ai_lookahead(mockGame)).toBe(0);
  });

  test('prefers eliminating a player over a comparable capture', () => {
    territory(1, 1, 5);
    territory(2, 2, 2);
    territory(3, 3, 2);
    territory(4, 3, 2);
    link(1, 2);
    link(1, 3);

    ai_lookahead(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('focuses a dominant leader over a weaker side target', () => {
    /*
     * Player 2 is the runaway leader. Capturing its isolated forward cell
     * (area 2) safely merges player 1's two groups, and the anti-runaway focus
     * makes it the pick over the lower-value capture of minor player 3's cell
     * (area 5). Player 2's dice mass (6,7,8) is what makes it dominant.
     */
    territory(1, 1, 6); // player 1 group A (with area 4)
    territory(4, 1, 6);
    territory(3, 1, 6); // player 1 group B
    territory(2, 2, 1); // leader's isolated forward cell, bridges groups A and B
    territory(5, 3, 1); // minor player's side-target cell
    territory(9, 3, 1); // keeps player 3 alive so area 5 is not an elimination
    territory(6, 2, 8); // leader's dice mass -> player 2 is dominant
    territory(7, 2, 8);
    territory(8, 2, 8);
    link(1, 4); // group A = {1, 4}
    link(1, 2);
    link(2, 3); // area 2 bridges group A (via 1) and group B (3)
    link(4, 5); // side target
    link(5, 9);
    link(6, 7);
    link(7, 8);

    ai_lookahead(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  /*
   * The genuine one-ply-continuation guard: capturing area 2 is a dead end,
   * but capturing area 3 sets up a follow-up onto area 4, and only the
   * continuation search makes 1->3 win. Disabling CONTINUATION_DEPTH flips this
   * test (verified), so it — not the multi-capture test below — is what catches
   * a regression in the recursive search itself.
   */
  test('values a capture that opens a profitable continuation attack', () => {
    territory(1, 1, 6);
    territory(2, 2, 1);
    territory(3, 2, 1);
    territory(4, 3, 1);
    link(1, 2);
    link(1, 3);
    link(3, 4);

    ai_lookahead(mockGame);

    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3);
  });

  test('is deterministic for identical states', () => {
    territory(1, 1, 5);
    territory(2, 1, 2);
    territory(3, 2, 2);
    territory(4, 3, 2);
    link(1, 3);
    link(2, 4);
    link(3, 4);

    ai_lookahead(mockGame);
    const firstMove = { from: mockGame.area_from, to: mockGame.area_to };

    mockGame.area_from = 0;
    mockGame.area_to = 0;
    ai_lookahead(mockGame);

    expect(mockGame.area_from).toBe(firstMove.from);
    expect(mockGame.area_to).toBe(firstMove.to);
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

    const result = ai_lookahead(mockGame);

    if (result !== 0) {
      const from = mockGame.adat[mockGame.area_from];
      const to = mockGame.adat[mockGame.area_to];
      expect(from.arm).toBe(1);
      expect(from.dice).toBeGreaterThan(1);
      expect(to.arm).not.toBe(1);
      expect(from.join[mockGame.area_to]).toBe(1);
    }
  });

  /*
   * Lookahead is standalone: it always plays its own highest-scoring searched
   * move, provided that move clears the posture-dependent attack threshold.
   * (There is no Claude fallback or override gate.) These tests pin that
   * selection via evaluateLookaheadTurn.
   */
  describe('search-driven move selection', () => {
    test('plays its highest-scoring searched move when one clears the threshold', () => {
      /*
       * Dominant attacker (PRESS posture) choosing among multiple captures:
       * 2->4 (a larger cell that also borders area 5) outscores the isolated
       * single-die capture 1->3 on immediate board value. Pinning the concrete
       * {from:2,to:4} guards the move-selection/scoring path — a regression that
       * mis-ranked the candidates would be caught here, not just the threshold
       * gate. (This board wins on immediate value alone; the recursive
       * continuation search is guarded separately by the dedicated test above.)
       */
      territory(1, 1, 8);
      territory(2, 1, 8);
      territory(3, 2, 1);
      territory(4, 2, 2);
      territory(5, 2, 2);
      link(1, 3);
      link(2, 4);
      link(4, 5);

      const decision = evaluateLookaheadTurn(mockGame);

      expect(decision.bestMove).toEqual({ from: 2, to: 4 });
      expect(decision.bestScore).toBeGreaterThan(decision.threshold);
      // With no Claude fallback, the chosen move is simply the searched best.
      expect(decision.chosenMove).toEqual(decision.bestMove);

      ai_lookahead(mockGame);
      expect(mockGame.area_from).toBe(decision.bestMove.from);
      expect(mockGame.area_to).toBe(decision.bestMove.to);
    });

    test('takes an available elimination its search values highly', () => {
      /*
       * Capturing area 3 removes player 3's only territory. It is ringed by the
       * attacker, so the captured cell stays safe and the elimination bonus
       * makes 1->3 the clear best move.
       */
      territory(1, 1, 8);
      territory(2, 1, 8);
      territory(3, 3, 1); // player 3's only territory, surrounded by player 1
      territory(4, 2, 2);
      territory(5, 2, 2);
      link(1, 3);
      link(2, 3);
      link(2, 4);
      link(4, 5);

      const decision = evaluateLookaheadTurn(mockGame);

      expect(decision.bestMove).toEqual({ from: 1, to: 3 });
      expect(decision.chosenMove).toEqual({ from: 1, to: 3 });

      ai_lookahead(mockGame);
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(3);
    });

    test('plays a searched move that clears the pressing threshold', () => {
      /*
       * Dominant player presses: the search finds a move above the (negative)
       * pressing threshold and plays it.
       */
      territory(2, 2, 7);
      territory(3, 2, 7);
      territory(5, 1, 4);
      territory(6, 1, 5);
      territory(7, 1, 6);
      territory(9, 1, 4);
      link(2, 5);
      link(2, 7);
      link(5, 7);

      const decision = evaluateLookaheadTurn(mockGame);
      expect(decision.bestMove).not.toBeNull();
      expect(decision.bestScore).toBeGreaterThan(decision.threshold);
      expect(decision.chosenMove).toEqual(decision.bestMove);

      ai_lookahead(mockGame);
      expect(mockGame.area_from).toBe(decision.bestMove.from);
      expect(mockGame.area_to).toBe(decision.bestMove.to);
    });
  });

  /*
   * Standalone contract — the defining property of this bot is that it decides
   * end to end and never imports, calls, or falls back to the Strategist bot
   * (ai_strategist, formerly ai_claude); the predecessor's override gate is gone.
   * The behavioral tests above would still pass if a Strategist fallback were
   * silently reintroduced, so these guards pin the decoupling directly: nothing
   * else fails if someone re-couples the two bots.
   */
  describe('standalone — no Strategist coupling', () => {
    test('exports exactly its own public surface (no Strategist re-export)', () => {
      expect(Object.keys(lookaheadModule).sort()).toEqual([
        'ai_lookahead',
        'evaluateLookaheadTurn',
        'winProbability',
      ]);
    });

    test('source imports only the shared dice-odds table, not the Strategist bot', () => {
      const source = readFileSync(
        fileURLToPath(new URL('../../src/ai/ai_lookahead.js', import.meta.url)),
        'utf8'
      );
      expect(source).not.toMatch(/ai_strategist/);
      expect(source).not.toMatch(/ai_claude/);
    });
  });

  /*
   * Strategic posture forms a U: the bar to attack is lowest when winning
   * (PRESS, to close out), still low when losing badly (WEAK, to claw back),
   * and highest in a balanced game (BASE, where the bot stays patient rather
   * than gambling a level position). We assert the ordering rather than the
   * exact constants so the test survives re-tuning while pinning the shape.
   */
  describe('attack-threshold posture', () => {
    const thresholdFor = setup => {
      setup();
      return evaluateLookaheadTurn(mockGame).threshold;
    };

    test('PRESS (winning) < WEAK (losing) < BASE (balanced)', () => {
      const press = thresholdFor(() => {
        // me (player 1) holds the overwhelming majority of dice -> press.
        territory(1, 1, 8);
        territory(2, 1, 8);
        territory(3, 1, 8);
        territory(4, 2, 2);
        territory(5, 3, 2);
        link(1, 4);
        link(1, 5);
      });

      // reset board
      for (let i = 0; i < mockGame.AREA_MAX; i++) {
        mockGame.adat[i].size = 0;
        mockGame.adat[i].arm = 0;
        mockGame.adat[i].dice = 0;
        mockGame.adat[i].join.fill(0);
      }

      const base = thresholdFor(() => {
        // balanced three-way split, my share between 15% and 38%.
        territory(1, 1, 3);
        territory(2, 1, 3);
        territory(3, 2, 5);
        territory(4, 2, 4);
        territory(5, 3, 3);
        territory(6, 3, 2);
        link(1, 3);
        link(3, 5);
      });

      for (let i = 0; i < mockGame.AREA_MAX; i++) {
        mockGame.adat[i].size = 0;
        mockGame.adat[i].arm = 0;
        mockGame.adat[i].dice = 0;
        mockGame.adat[i].join.fill(0);
      }

      const weak = thresholdFor(() => {
        // me with a tiny dice share against two strong rivals -> weak.
        territory(1, 1, 1);
        territory(2, 2, 8);
        territory(3, 2, 8);
        territory(4, 3, 8);
        territory(5, 3, 8);
        link(1, 2);
        link(1, 4);
      });

      expect(press).toBeLessThan(weak);
      expect(weak).toBeLessThan(base);
    });
  });

  /*
   * Games can seat more than the usual 8 players (the online tournament runs a
   * 9-bot field). The bot must size its per-player tables to the real player
   * count, not a hard-coded 8, or it crashes when seated at the highest index
   * and silently drops that player from its census.
   */
  describe('N-player robustness (9-player games)', () => {
    test('plays a legal move when it is the highest-indexed player (index 8)', () => {
      mockGame.jun = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      mockGame.ban = 8; // get_pn() -> 8
      territory(1, 8, 5); // player 8 (the AI) owns area 1
      territory(2, 2, 1);
      link(1, 2);

      expect(() => ai_lookahead(mockGame)).not.toThrow();
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });

    test('counts a high-index enemy in its census (anti-runaway sees player 8)', () => {
      // Player 0 is the AI; player 8 is a runaway leader it must be able to see.
      mockGame.jun = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      mockGame.ban = 0; // get_pn() -> 0
      territory(1, 0, 6); // AI's cell, adjacent to the leader and a minor player
      territory(2, 8, 1); // leader's forward cell (safe to take: only borders the AI)
      territory(3, 2, 1); // minor player's cell
      territory(6, 2, 1); // minor player's second (free-standing) cell, so taking area 3 is no elimination
      territory(4, 8, 8); // leader's dice mass (separate cluster) -> player 8 is dominant
      territory(5, 8, 8);
      link(1, 2);
      link(1, 3);
      link(4, 5);

      expect(() => ai_lookahead(mockGame)).not.toThrow();
      // With player 8 correctly seen as the dominant leader, the AI focuses it.
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });

    test('sizes its tables to game.player.length even when no high-index player is on the board', () => {
      /*
       * The other two cases drive the array sizing via the highest board owner
       * (maxOwner + 1). This one pins the third term of the Math.max: a seated
       * 10th player that currently owns no territory (so maxOwner stays low) must
       * still be sized in — and its stock read without an out-of-range access.
       */
      mockGame.player[8] = { stock: 0 };
      mockGame.player[9] = { stock: 7 }; // high-index player's stock must be read safely
      expect(mockGame.player).toHaveLength(10);

      mockGame.jun = [0, 1];
      mockGame.ban = 0; // get_pn() -> 0
      territory(1, 0, 5); // only owners on the board are 0 and 2 -> maxOwner = 2
      territory(2, 2, 1);
      link(1, 2);

      expect(() => ai_lookahead(mockGame)).not.toThrow();
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });
  });

  test('declines a sub-floor-odds attack because of the low-odds penalty', () => {
    /*
     * me (player 1) can only attack an 8-dice area with 2 dice (~0.6% to win);
     * the defender keeps a second territory so no elimination bonus applies.
     */
    territory(1, 1, 2);
    territory(2, 1, 3);
    territory(3, 2, 8);
    territory(4, 2, 5);
    link(1, 2);
    link(1, 3);
    link(3, 4);

    const decision = evaluateLookaheadTurn(mockGame);

    /*
     * The only real attack is found, but the low-odds penalty drives its score
     * strongly negative (a single capture's raw value is ~1-2 units, so a score
     * below -1.5 can only come from the penalty), and Lookahead declines.
     */
    expect(decision.bestMove).toEqual({ from: 1, to: 3 });
    expect(decision.bestScore).toBeLessThan(-1.5);
    expect(decision.chosenMove).toBeNull();
    expect(ai_lookahead(mockGame)).toBe(0);
  });

  test('proposes only legal moves across many random boards', () => {
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let trial = 0; trial < 300; trial++) {
      // reset
      for (let i = 0; i < mockGame.AREA_MAX; i++) {
        mockGame.adat[i].size = 0;
        mockGame.adat[i].arm = 0;
        mockGame.adat[i].dice = 0;
        mockGame.adat[i].join.fill(0);
      }
      const numPlayers = 2 + Math.floor(rand() * 4);
      const maxArea = 8 + Math.floor(rand() * (mockGame.AREA_MAX - 8));
      for (let i = 1; i < maxArea; i++) {
        if (rand() < 0.85)
          territory(i, Math.floor(rand() * numPlayers), 1 + Math.floor(rand() * 8));
      }
      for (let a = 1; a < maxArea; a++) {
        if (mockGame.adat[a].size === 0) continue;
        for (let b = a + 1; b < maxArea; b++) {
          if (mockGame.adat[b].size === 0) continue;
          if (rand() < 0.2) link(a, b);
        }
      }
      mockGame.ban = Math.floor(rand() * numPlayers);

      mockGame.area_from = 0;
      mockGame.area_to = 0;
      const result = ai_lookahead(mockGame);

      if (result !== 0 && mockGame.area_from > 0 && mockGame.area_to > 0) {
        const pn = mockGame.get_pn();
        const from = mockGame.adat[mockGame.area_from];
        const to = mockGame.adat[mockGame.area_to];
        expect(from.arm).toBe(pn); // attack from own territory
        expect(from.dice).toBeGreaterThan(1); // with more than one die
        expect(to.arm).not.toBe(pn); // against an enemy
        expect(from.join[mockGame.area_to]).toBe(1); // that is adjacent
      }
    }
  });

  /*
   * Press-to-close override (issue #115): a clear winner must keep attacking
   * even when every remaining move is a penalized near-even coinflip, or
   * AI-vs-AI games freeze into turn-cap stalemates. "Clearly winning" =
   * strict territory lead AND (dominant dice share OR ≤3 players alive with
   * at least the DOMINANCE_SHARE dice floor — issue #132).
   */
  describe('press-to-close override (issue #115)', () => {
    test('plays the searched best move from a clearly-winning maxed position even below the EV bar', () => {
      /*
       * me (player 1): 4 territories vs 2 and 1 (strict lead) and 32/56 dice
       * (dominant share). The only legal attack is an 8v8 border coinflip
       * whose score (~-2, driven by the low-odds penalty) sits far below even
       * the PRESS threshold — pre-#115 the bot passed here forever.
       */
      territory(1, 1, 8);
      territory(2, 1, 8);
      territory(3, 1, 8);
      territory(4, 1, 8);
      territory(5, 2, 8);
      territory(6, 2, 8);
      territory(7, 3, 8);
      link(1, 2);
      link(2, 3);
      link(3, 4);
      link(4, 5); // my only enemy border: the 8v8
      link(5, 6);
      link(6, 7);

      const decision = evaluateLookaheadTurn(mockGame);

      expect(decision.pressToClose).toBe(true);
      expect(decision.bestMove).toEqual({ from: 4, to: 5 });
      expect(decision.bestScore).toBeLessThan(decision.threshold); // the plain EV gate would decline
      expect(decision.chosenMove).toEqual(decision.bestMove); // the override presses anyway

      ai_lookahead(mockGame);
      expect(mockGame.area_from).toBe(4);
      expect(mockGame.area_to).toBe(5);
    });

    test('does not fire without a strict territory lead (all-8s parity stays patient)', () => {
      /*
       * Same maxed frontier but tied 3-vs-3 territories: not "clearly winning",
       * so the normal EV gate applies and the bot still declines the coinflip.
       * Player 3's off-board dice mass keeps my share at 24/64 (< the two-player
       * PRESS cutoff) so the posture under test is the patient BASE bar — in a
       * pure duel the pre-existing PRESS posture would take this coinflip on
       * its own, with or without the #115 override.
       */
      territory(1, 1, 8);
      territory(2, 1, 8);
      territory(3, 1, 8);
      territory(4, 2, 8);
      territory(5, 2, 8);
      territory(6, 2, 8);
      territory(7, 3, 8); // third player's dice mass -> my share 0.375, BASE posture
      territory(8, 3, 8);
      link(1, 2);
      link(2, 3);
      link(3, 4); // the 8v8 border
      link(4, 5);
      link(5, 6);
      link(6, 7);
      link(7, 8);

      const decision = evaluateLookaheadTurn(mockGame);

      expect(decision.pressToClose).toBe(false);
      expect(decision.chosenMove).toBeNull();
      expect(ai_lookahead(mockGame)).toBe(0);
    });

    test('does not fire in a narrow field while weak on dice (issue #132)', () => {
      /*
       * me (player 1): 4 territories vs 3 and 1 — a strict territory lead in a
       * 3-player field — but only 7/39 dice (~18% share, far below the
       * DOMINANCE_SHARE floor). My only legal attack is a ~10%-odds 4v8.
       * Pre-#132 the bare ≤3-players disjunct pressed anyway, burning the one
       * stack I needed for defense; with the dice floor the bot passes.
       */
      territory(1, 1, 4); // my only stack able to attack
      territory(2, 1, 1);
      territory(3, 1, 1);
      territory(4, 1, 1);
      territory(5, 2, 8); // the lopsided border defender
      territory(6, 2, 8);
      territory(7, 2, 8);
      territory(8, 3, 8);
      link(1, 2);
      link(2, 3);
      link(3, 4);
      link(1, 5); // my only enemy border: the 4v8
      link(5, 6);
      link(6, 7);
      link(7, 8);

      const decision = evaluateLookaheadTurn(mockGame);

      expect(decision.bestMove).toEqual({ from: 1, to: 5 }); // the search still sees the move
      expect(decision.pressToClose).toBe(false); // but the override must not force it
      expect(decision.chosenMove).toBeNull();
      expect(ai_lookahead(mockGame)).toBe(0);
      expect(mockGame.area_from).toBe(0);
      expect(mockGame.area_to).toBe(0);
    });

    test('narrow-field press still fires at exactly the DOMINANCE_SHARE floor', () => {
      /*
       * me (player 1): 3 territories vs 2 and 1 (strict lead) holding exactly
       * 16/40 = 40% of the dice in a 3-player field. The dominant-dice trigger
       * is strict (> 0.4) so it stays off; the narrow-field trigger's floor is
       * >= (mirroring Strategist), so the press fires and takes the 8v8 the
       * plain EV gate would decline.
       */
      territory(1, 1, 8);
      territory(2, 1, 7);
      territory(3, 1, 1);
      territory(4, 2, 8);
      territory(5, 2, 8);
      territory(6, 3, 8);
      link(1, 2);
      link(2, 3);
      link(1, 4); // my only enemy border: the 8v8
      link(4, 5);
      link(5, 6);

      const decision = evaluateLookaheadTurn(mockGame);

      expect(decision.pressToClose).toBe(true);
      expect(decision.bestMove).toEqual({ from: 1, to: 4 });
      expect(decision.bestScore).toBeLessThan(decision.threshold); // the plain EV gate would decline
      expect(decision.chosenMove).toEqual(decision.bestMove);
    });
  });
});
