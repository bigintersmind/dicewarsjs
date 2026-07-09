/**
 * Same-seed match determinism (issue #151).
 *
 * The engine has always been seed-deterministic; these tests lock in the bot
 * layer too. The three formerly-`Math.random` bots (Example, Default, Adaptive)
 * must draw from the seeded per-decision RNG so that a match is a pure function
 * of its seed — the guarantee `npm run arena`'s single-seed ELO, replay
 * debugging, and the ML pipeline's seed-range sharding (D-13) all rely on.
 */
import { runMatch } from '../../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';

/** The three stochastic bots plus a cheap deterministic seat. */
const FIELD_NAMES = ['Example', 'Default', 'Adaptive', 'Defensive'];

function fieldBots() {
  return FIELD_NAMES.map(name => {
    const bot = BUILT_IN_BOTS.find(b => b.name === name);
    if (!bot) throw new Error(`Built-in bot "${name}" not found`);
    return { name: bot.name, fn: bot.fn };
  });
}

describe('same-seed match determinism (issue #151)', () => {
  it.each([11, 42, 1337])(
    'repeated runMatch calls with seed %i produce byte-identical results',
    seed => {
      const run = () => runMatch({ bots: fieldBots(), seed, maxTurns: 300 });
      const a = run();
      const b = run();

      expect(b.turnCount).toBe(a.turnCount);
      expect(b.winner).toBe(a.winner);
      expect(b.placements).toEqual(a.placements);
      expect(b.botStats).toEqual(a.botStats);
      expect(JSON.stringify(b.finalState)).toBe(JSON.stringify(a.finalState));
    }
  );

  it('stochastic bots still vary across different seeds', () => {
    // Not flaky: every value here is a pure function of the seed, so this
    // either always passes or always fails for a given implementation.
    const turnCounts = [1, 2, 3, 4, 5].map(
      seed => runMatch({ bots: fieldBots(), seed, maxTurns: 300 }).turnCount
    );
    expect(new Set(turnCounts).size).toBeGreaterThan(1);
  });
});
