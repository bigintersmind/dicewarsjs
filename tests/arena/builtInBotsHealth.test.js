import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { runMatch } from '../../src/arena/matchRunner.js';

/**
 * Field-wide invariant for the trusted built-in roster (#53).
 *
 * The #52 regression test guards BC specifically — but the actual class of failure is
 * "any trusted built-in wired up so it errors every turn." A mis-registered built-in
 * never throws out of runMatch (runBotDirect swallows the throw into a counter), so the
 * match completes and the bot just shows up as a clean low win% / low ELO. The only place
 * the breakage is visible is the per-bot `errors` / `attacksMade` counters.
 *
 * This asserts every built-in runs the full field without a single error and attacks at
 * least once. It catches the whole class, not just the BC instance.
 */
describe('built-in bot field health (#53)', () => {
  it('every built-in runs the full field with zero errors and attacks at least once', () => {
    const field = BUILT_IN_BOTS.map(b => ({ name: b.name, fn: b.fn }));

    const totals = new Map(field.map(b => [b.name, { errors: 0, attacks: 0 }]));

    /*
     * Sum across seeds on purpose. Three opponents (ai_default, ai_adaptive, ai_example)
     * pick moves with unseeded Math.random, so the engine seed fixes only the map/dice, not
     * the board trajectory: on a single seed a STOP-heavy net (BC/PPO) can legitimately make
     * 0 attacks. The cross-seed sum is what keeps `attacks > 0` non-flaky. (`errors` is
     * seed-independent — a healthy built-in never errors, so its sum stays 0.) Mirrors the
     * #52 BC test.
     */
    for (let seed = 1; seed <= 6; seed++) {
      const res = runMatch({ bots: field, seed });
      for (const stat of res.botStats) {
        const t = totals.get(stat.name);
        t.errors += stat.errors;
        t.attacks += stat.attacksMade;
      }
    }

    for (const [name, t] of totals) {
      // A healthy built-in never errors (a registration/adapter bug would) and attacks at least once.
      expect({ name, errors: t.errors }).toEqual({ name, errors: 0 });
      expect(t.attacks).toBeGreaterThan(0);
    }
  }, 60_000);
});
