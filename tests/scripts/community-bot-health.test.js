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

/** Look a built-in bot up by name so tests survive a roster reorder (indices shift). */
const byName = name => BUILT_IN_BOTS.find(b => b.name === name);

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

  it('passes a do-nothing bot that never acted (all-zero counters — degenerate, not broken)', () => {
    // The whole point of gate 2: distinguish "never acted" (a voluntary pass/STOP bot) from
    // "acted illegally every turn". An all-zero bot must pass, matching botErrorReport's policy.
    const health = assessBotMatchHealth(resultWith({}), 'Bot');
    expect(health.ok).toBe(true);
    expect(health.reason).toBeNull();
  });

  it('tolerates many invalid moves once the bot has landed at least one valid attack', () => {
    // Intended policy (reuse reportBotErrors, don't invent a threshold): invalidMoves only
    // flags when the bot never landed an attack. A bot with attacksMade > 0 is not flagged —
    // this pins that as a deliberate contract and guards the attacks:attacksMade mapping.
    const health = assessBotMatchHealth(resultWith({ attacksMade: 5, invalidMoves: 500 }), 'Bot');
    expect(health.ok).toBe(true);
    expect(health.reason).toBeNull();
  });

  it('throws (fails closed) when the bot name is absent from botStats', () => {
    expect(() => assessBotMatchHealth(resultWith({}), 'Ghost')).toThrow(
      /not found in result\.botStats/
    );
  });

  it('catches a bot whose body throws every turn, run through a real match (#148)', () => {
    const throwFn = compileSandboxedBot('throw new Error("boom every turn");', 'ThrowBot');
    const opponent = byName('Example');
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

  it('catches a bot that returns an invalid move every turn, run through a real match', () => {
    const garbageFn = compileSandboxedBot('return { from: -1, to: -1 };', 'GarbageBot');
    const opponent = byName('Example');
    const result = runMatch({
      bots: [{ name: 'GarbageBot', fn: garbageFn }, opponent],
      seed: 42,
      maxTurns: 200,
    });

    // Mirror of the throwing-bot test for the invalid-move gate: the engine folds each illegal
    // move into invalidMoves (never throwing out of runMatch), so the health check must flag it
    // via the reused reportBotErrors masquerade path.
    const health = assessBotMatchHealth(result, 'GarbageBot');
    expect(health.ok).toBe(false);
    expect(health.invalidMoves).toBeGreaterThan(0);
    expect(health.attacksMade).toBe(0);
    expect(health.reason).toMatch(/invalid/i);
  });

  it('passes a real, valid built-in bot run through a real match', () => {
    const bot = byName('Lookahead');
    const opponent = byName('Example');
    const result = runMatch({ bots: [bot, opponent], seed: 42, maxTurns: 200 });
    const health = assessBotMatchHealth(result, bot.name);
    expect(health.ok).toBe(true);
    expect(health.reason).toBeNull();
  });
});
