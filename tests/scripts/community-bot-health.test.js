import { assessBotMatchHealth } from '../../scripts/lib/community-bot-health.mjs';
import { runMatch } from '../../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { compileSandboxedBot } from '../../scripts/lib/bot-sandbox.mjs';

/**
 * Build a minimal runMatch-shaped result carrying a single bot's stat, so the pure
 * decision logic can be exercised without running a full game.
 */
function resultWith(stat) {
  return { botStats: [{ name: 'Bot', attacksMade: 0, errors: 0, invalidMoves: 0, ...stat }] };
}

describe('assessBotMatchHealth', () => {
  it('passes a healthy bot that landed attacks with no errors or invalid moves', () => {
    const health = assessBotMatchHealth(resultWith({ attacksMade: 45 }), 'Bot');
    expect(health.ok).toBe(true);
    expect(health.reason).toBeNull();
    expect(health.errors).toBe(0);
    expect(health.invalidMoves).toBe(0);
    expect(health.attacksMade).toBe(45);
  });

  it('fails a bot that threw during the match, naming the error count', () => {
    const health = assessBotMatchHealth(resultWith({ errors: 100 }), 'Bot');
    expect(health.ok).toBe(false);
    expect(health.errors).toBe(100);
    // The message must name the error count so the PR comment is actionable (#148 AC).
    expect(health.reason).toContain('100');
    expect(health.reason).toMatch(/threw|error/i);
  });

  it('fails a bot that threw even once — a thrown exception is never legitimate', () => {
    const health = assessBotMatchHealth(resultWith({ errors: 1, attacksMade: 50 }), 'Bot');
    expect(health.ok).toBe(false);
    expect(health.reason).toContain('1');
  });

  it('fails a bot that only ever submitted invalid moves (the #53 masquerade)', () => {
    const health = assessBotMatchHealth(resultWith({ invalidMoves: 300 }), 'Bot');
    expect(health.ok).toBe(false);
    expect(health.invalidMoves).toBe(300);
    expect(health.reason).toMatch(/invalid/i);
  });

  it('does not false-positive on a productive bot with a single stray invalid move', () => {
    const health = assessBotMatchHealth(resultWith({ attacksMade: 45, invalidMoves: 1 }), 'Bot');
    expect(health.ok).toBe(true);
    expect(health.reason).toBeNull();
  });

  it('catches a bot whose body throws every turn, run through a real match (#148)', () => {
    const throwFn = compileSandboxedBot('throw new Error("boom every turn");', 'ThrowBot');
    const opponent = BUILT_IN_BOTS[0];
    const result = runMatch({
      bots: [{ name: 'ThrowBot', fn: throwFn }, opponent],
      seed: 42,
      maxTurns: 200,
    });

    // The bug: runMatch completes normally (the engine swallows the throw), so the old
    // validator reported PASS. The health check must catch the error counter it surfaces.
    const health = assessBotMatchHealth(result, 'ThrowBot');
    expect(health.ok).toBe(false);
    expect(health.errors).toBeGreaterThan(0);
    expect(health.reason).toContain(String(health.errors));
  });

  it('passes a real, valid built-in bot run through a real match', () => {
    const bot = { name: BUILT_IN_BOTS[5].name, fn: BUILT_IN_BOTS[5].fn };
    const opponent = { name: BUILT_IN_BOTS[0].name, fn: BUILT_IN_BOTS[0].fn };
    const result = runMatch({ bots: [bot, opponent], seed: 42, maxTurns: 200 });
    const health = assessBotMatchHealth(result, bot.name);
    expect(health.ok).toBe(true);
    expect(health.reason).toBeNull();
  });
});
