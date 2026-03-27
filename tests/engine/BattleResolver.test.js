import {
  rollDice,
  resolveBattle,
  calculateAttackProbability,
} from '../../src/engine/BattleResolver.js';
import { createRng } from '../../src/engine/rng.js';

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
