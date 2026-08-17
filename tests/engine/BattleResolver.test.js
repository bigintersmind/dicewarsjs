import {
  rollDice,
  rollAdvantage,
  resolveBattle,
  calculateAttackProbability,
} from '../../src/engine/BattleResolver.js';
import { createRng } from '../../src/engine/rng.js';

/**
 * An RNG stub that replays a fixed list of faces, so a test can drive the
 * implementation over an exhaustive enumeration of dice pools.
 */
function scriptedRng(faces) {
  let i = 0;
  return {
    nextInt: () => {
      if (i >= faces.length) throw new Error(`scriptedRng exhausted after ${i} draws`);
      return faces[i++];
    },
    draws: () => i,
  };
}

/** Reference "keep the highest `count`" split, independent of the implementation. */
function referenceKept(faces, count) {
  return [...faces].sort((a, b) => b - a).slice(0, count);
}

describe('rollDice', () => {
  it('returns deterministic results with the same RNG', () => {
    const r1 = rollDice(5, createRng(42));
    const r2 = rollDice(5, createRng(42));
    expect(r1).toEqual(r2);
  });

  it('returns values between 1 and 6', () => {
    const rng = createRng(99);
    for (let i = 0; i < 100; i++) {
      const { values } = rollDice(3, rng);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(6);
      }
    }
  });

  it('total equals sum of values', () => {
    const rng = createRng(7);
    const { values, total } = rollDice(6, rng);
    expect(total).toBe(values.reduce((a, b) => a + b, 0));
  });

  it('returns correct count of dice', () => {
    const rng = createRng(1);
    expect(rollDice(1, rng).values.length).toBe(1);
    expect(rollDice(8, createRng(1)).values.length).toBe(8);
  });

  it('returns empty result for 0 dice', () => {
    const rng = createRng(1);
    expect(rollDice(0, rng)).toEqual({ values: [], total: 0 });
  });

  it('returns empty result for negative count', () => {
    const rng = createRng(1);
    expect(rollDice(-3, rng)).toEqual({ values: [], total: 0 });
  });
});

describe('resolveBattle', () => {
  it('returns deterministic results with the same RNG seed', () => {
    const r1 = resolveBattle(4, 3, createRng(42));
    const r2 = resolveBattle(4, 3, createRng(42));
    expect(r1).toEqual(r2);
  });

  it('returns a BattleResult with expected shape', () => {
    const result = resolveBattle(3, 2, createRng(10));
    expect(result).toHaveProperty('attackerRoll');
    expect(result).toHaveProperty('defenderRoll');
    expect(result).toHaveProperty('success');
    expect(typeof result.success).toBe('boolean');
    expect(result.attackerRoll.values.length).toBe(3);
    expect(result.defenderRoll.values.length).toBe(2);
  });

  it('success is true when attacker total > defender total', () => {
    // Run many battles and verify the success flag is consistent
    const rng = createRng(123);
    for (let i = 0; i < 50; i++) {
      const r = resolveBattle(4, 2, rng);
      if (r.attackerRoll.total > r.defenderRoll.total) {
        expect(r.success).toBe(true);
      } else {
        expect(r.success).toBe(false);
      }
    }
  });

  it('throws RangeError for non-positive dice counts', () => {
    const rng = createRng(1);
    expect(() => resolveBattle(0, 3, rng)).toThrow(RangeError);
    expect(() => resolveBattle(3, 0, rng)).toThrow(RangeError);
    expect(() => resolveBattle(-1, 3, rng)).toThrow(RangeError);
    expect(() => resolveBattle(3, -1, rng)).toThrow(RangeError);
  });

  it('tie goes to defender (attacker must strictly exceed)', () => {
    // With enough iterations we should hit a tie
    const rng = createRng(777);
    let foundTie = false;
    for (let i = 0; i < 500; i++) {
      const r = resolveBattle(3, 3, rng);
      if (r.attackerRoll.total === r.defenderRoll.total) {
        expect(r.success).toBe(false);
        foundTie = true;
      }
    }
    expect(foundTie).toBe(true);
  });
});

describe('rollAdvantage', () => {
  it('keeps exactly `count` dice whose sum is the reported total', () => {
    const rng = createRng(2026);
    for (let count = 1; count <= 8; count++) {
      for (let advantage = 0; advantage <= 2; advantage++) {
        const { values, total, dropped } = rollAdvantage(count, advantage, rng);
        expect(values).toHaveLength(count);
        expect(dropped).toHaveLength(advantage);
        expect(total).toBe(values.reduce((a, b) => a + b, 0));
        for (const v of [...values, ...dropped]) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(6);
        }
      }
    }
  });

  it('drops exactly the k lowest of the rolled pool (kept dice stay in roll order)', () => {
    for (const [count, advantage] of [
      [3, 1],
      [3, 2],
      [1, 1],
      [8, 2],
      [5, 3],
    ]) {
      // Roll the same seed twice: once raw (the full pool), once through rollAdvantage.
      const raw = rollDice(count + advantage, createRng(1234)).values;
      const { values, dropped } = rollAdvantage(count, advantage, createRng(1234));

      // Kept + dropped is exactly the pool, and kept is the `count` highest.
      expect([...values, ...dropped].sort()).toEqual([...raw].sort());
      expect([...values].sort((a, b) => b - a)).toEqual(referenceKept(raw, count));

      /*
       * Both output arrays preserve the original roll order (a stable animation).
       * The dropped set is the `advantage` lowest, earliest-rolled die first on a tie.
       */
      const droppedIdx = new Set(
        raw
          .map((_, i) => i)
          .sort((a, b) => raw[a] - raw[b] || a - b)
          .slice(0, advantage)
      );
      expect(values).toEqual(raw.filter((_, i) => !droppedIdx.has(i)));
      expect(dropped).toEqual(raw.filter((_, i) => droppedIdx.has(i)));
    }
  });

  it('ties among the lowest drop the earliest-rolled die (deterministic split)', () => {
    // Pool [4, 4, 6]: keep 2 → drop one of the two 4s; the first one goes.
    const { values, dropped } = rollAdvantage(2, 1, scriptedRng([4, 4, 6]));
    expect(values).toEqual([4, 6]);
    expect(dropped).toEqual([4]);
  });

  it('consumes exactly count + advantage RNG draws', () => {
    for (const [count, advantage] of [
      [1, 0],
      [3, 0],
      [3, 1],
      [3, 2],
      [8, 2],
    ]) {
      const rng = createRng(77);
      rollAdvantage(count, advantage, rng);

      const control = createRng(77);
      for (let i = 0; i < count + advantage; i++) control.nextInt(1, 6);

      expect(rng.state()).toBe(control.state());
    }
  });

  it('advantage 0 is identical to rollDice — values, total and post-roll RNG state', () => {
    for (let count = 1; count <= 8; count++) {
      const a = createRng(4242);
      const b = createRng(4242);
      const adv = rollAdvantage(count, 0, a);
      const plain = rollDice(count, b);

      expect(adv.values).toEqual(plain.values);
      expect(adv.total).toBe(plain.total);
      expect(adv.dropped).toEqual([]);
      expect(a.state()).toBe(b.state());
    }
  });

  it('throws on invalid count', () => {
    const rng = createRng(1);
    expect(() => rollAdvantage(0, 0, rng)).toThrow(RangeError);
    expect(() => rollAdvantage(-1, 0, rng)).toThrow(/count/);
    expect(() => rollAdvantage(2.5, 0, rng)).toThrow(/integer/);
    expect(() => rollAdvantage('3', 0, rng)).toThrow(/count/);
    expect(() => rollAdvantage(undefined, 0, rng)).toThrow(/count/);
  });

  it('throws on invalid advantage', () => {
    const rng = createRng(1);
    expect(() => rollAdvantage(3, -1, rng)).toThrow(RangeError);
    expect(() => rollAdvantage(3, 1.5, rng)).toThrow(/advantage/);
    expect(() => rollAdvantage(3, '1', rng)).toThrow(/advantage/);
    expect(() => rollAdvantage(3, undefined, rng)).toThrow(/advantage/);
  });
});

describe('resolveBattle — luck handicap options', () => {
  it('no options reproduces the un-optioned result exactly (regression pin)', () => {
    for (const seed of [42, 1337, 2026]) {
      const plain = resolveBattle(4, 3, createRng(seed));
      const explicit = resolveBattle(4, 3, createRng(seed), {
        attackerAdvantage: 0,
        defenderAdvantage: 0,
      });
      expect(explicit.attackerRoll.values).toEqual(plain.attackerRoll.values);
      expect(explicit.defenderRoll.values).toEqual(plain.defenderRoll.values);
      expect(explicit.success).toBe(plain.success);

      // ...and both consume the same number of draws as a bare 4 + 3 roll.
      const rngA = createRng(seed);
      resolveBattle(4, 3, rngA);
      const control = createRng(seed);
      for (let i = 0; i < 7; i++) control.nextInt(1, 6);
      expect(rngA.state()).toBe(control.state());
    }
  });

  it('applies the attacker advantage only to the attacker', () => {
    const rng = createRng(9);
    const battle = resolveBattle(3, 3, rng, { attackerAdvantage: 1 });

    expect(battle.attackerRoll.values).toHaveLength(3);
    expect(battle.attackerRoll.dropped).toHaveLength(1);
    expect(battle.defenderRoll.values).toHaveLength(3);
    expect(battle.defenderRoll.dropped).toEqual([]);

    // 4 attacker draws + 3 defender draws.
    const control = createRng(9);
    for (let i = 0; i < 7; i++) control.nextInt(1, 6);
    expect(rng.state()).toBe(control.state());

    // The attacker kept the 3 highest of the 4 rolled.
    const raw = rollDice(4, createRng(9)).values;
    expect([...battle.attackerRoll.values].sort((a, b) => b - a)).toEqual(referenceKept(raw, 3));
  });

  it('applies the defender advantage only to the defender', () => {
    const rng = createRng(9);
    const battle = resolveBattle(3, 3, rng, { defenderAdvantage: 2 });

    expect(battle.attackerRoll.values).toHaveLength(3);
    expect(battle.attackerRoll.dropped).toEqual([]);
    expect(battle.defenderRoll.values).toHaveLength(3);
    expect(battle.defenderRoll.dropped).toHaveLength(2);

    // 3 attacker draws + 5 defender draws.
    const control = createRng(9);
    for (let i = 0; i < 8; i++) control.nextInt(1, 6);
    expect(rng.state()).toBe(control.state());
  });

  /*
   * `options = {}` only defaults an omitted/undefined argument. A caller that
   * threads an optional options object through (`resolveBattle(a, d, rng, opts)`
   * where opts is null) would otherwise get an opaque destructuring TypeError
   * instead of a fair fight.
   */
  it('treats an explicit null options as no handicap', () => {
    const withNull = resolveBattle(3, 3, createRng(7), null);
    const withNothing = resolveBattle(3, 3, createRng(7));
    expect(withNull).toEqual(withNothing);
    expect(withNull.attackerRoll.dropped).toEqual([]);
    expect(withNull.defenderRoll.dropped).toEqual([]);
  });

  it('rejects an invalid advantage before rolling', () => {
    expect(() => resolveBattle(3, 3, createRng(1), { attackerAdvantage: -1 })).toThrow(/advantage/);
    expect(() => resolveBattle(3, 3, createRng(1), { defenderAdvantage: 1.5 })).toThrow(
      /advantage/
    );
  });

  it('ties still go to the defender with a handicap in play', () => {
    // Attacker keeps 2 of [1,5,5] → 10; defender keeps 2 of [4,6] → 10. Tie ⇒ defender.
    const battle = resolveBattle(2, 2, scriptedRng([1, 5, 5, 4, 6]), { attackerAdvantage: 1 });
    expect(battle.attackerRoll.total).toBe(10);
    expect(battle.defenderRoll.total).toBe(10);
    expect(battle.success).toBe(false);
  });
});

describe('advantage-dice odds calibration (exact enumeration)', () => {
  /*
   * Pins the *measured* numbers issue #179 shipped on: k=1 lifts an even 3v3
   * attack from 45.4% to 62.2%, and a lucky defender drops the attacker to 29.2%.
   * The distributions are enumerated by driving the real rollAdvantage over every
   * possible pool (6^(count+advantage) ≤ 1296 per side) — the drop rule measured
   * here is the shipped one. The comparison is re-stated (`aTotal > dTotal`), so
   * the tie rule itself is pinned separately, by the scripted-tie test above.
   */
  function keptTotalDistribution(count, advantage) {
    const pool = count + advantage;
    const counts = new Map();
    const faces = new Array(pool);
    const recurse = i => {
      if (i === pool) {
        const { total, values, dropped } = rollAdvantage(count, advantage, scriptedRng(faces));
        expect(values).toHaveLength(count);
        expect(dropped).toHaveLength(advantage);
        counts.set(total, (counts.get(total) ?? 0) + 1);
        return;
      }
      for (let v = 1; v <= 6; v++) {
        faces[i] = v;
        recurse(i + 1);
      }
    };
    recurse(0);
    return counts;
  }

  /** Exact P(attacker wins); ties go to the defender. */
  function attackerWinProbability(
    attackerDice,
    attackerAdvantage,
    defenderDice,
    defenderAdvantage
  ) {
    const atk = keptTotalDistribution(attackerDice, attackerAdvantage);
    const def = keptTotalDistribution(defenderDice, defenderAdvantage);
    let outcomes = 0;
    let wins = 0;
    for (const [aTotal, aCount] of atk) {
      for (const [dTotal, dCount] of def) {
        const weight = aCount * dCount;
        outcomes += weight;
        if (aTotal > dTotal) wins += weight;
      }
    }
    expect(outcomes).toBe(
      6 ** (attackerDice + attackerAdvantage) * 6 ** (defenderDice + defenderAdvantage)
    );
    return wins / outcomes;
  }

  it('3v3 with no handicap: attacker wins 45.4%', () => {
    expect(attackerWinProbability(3, 0, 3, 0) * 100).toBeCloseTo(45.4, 1);
  });

  it('3v3 with attacker +1 advantage die: attacker wins 62.2%', () => {
    expect(attackerWinProbability(3, 1, 3, 0) * 100).toBeCloseTo(62.2, 1);
  });

  it('3v3 with defender +1 advantage die: attacker wins 29.2%', () => {
    expect(attackerWinProbability(3, 0, 3, 1) * 100).toBeCloseTo(29.2, 1);
  });

  // k=2 is the top rung ("Very lucky"), so its shipped number is pinned too.
  it('3v3 with attacker +2 advantage dice: attacker wins 73.3%', () => {
    expect(attackerWinProbability(3, 2, 3, 0) * 100).toBeCloseTo(73.3, 1);
  });
});

describe('calculateAttackProbability', () => {
  it('returns 0 for non-positive dice counts', () => {
    expect(calculateAttackProbability(0, 3)).toBe(0);
    expect(calculateAttackProbability(3, 0)).toBe(0);
    expect(calculateAttackProbability(-1, 3)).toBe(0);
  });

  it('returns 0.95 when attacker has 3x+ advantage', () => {
    expect(calculateAttackProbability(9, 3)).toBe(0.95);
    expect(calculateAttackProbability(6, 2)).toBe(0.95);
  });

  it('returns 0.05 when defender has 3x+ advantage', () => {
    expect(calculateAttackProbability(2, 6)).toBe(0.05);
    expect(calculateAttackProbability(1, 3)).toBe(0.05);
  });

  it('returns ~0.5 for equal dice', () => {
    const p = calculateAttackProbability(4, 4);
    expect(p).toBe(0.5);
  });

  it('returns values in (0, 1) for normal cases', () => {
    for (let a = 1; a <= 8; a++) {
      for (let d = 1; d <= 8; d++) {
        const p = calculateAttackProbability(a, d);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
      }
    }
  });

  it('higher attacker dice yields higher probability', () => {
    const p1 = calculateAttackProbability(2, 4);
    const p2 = calculateAttackProbability(4, 4);
    const p3 = calculateAttackProbability(6, 4);
    expect(p1).toBeLessThan(p2);
    expect(p2).toBeLessThan(p3);
  });
});
