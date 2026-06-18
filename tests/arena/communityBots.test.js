/**
 * Community bot loader tests
 *
 * Verifies the curated registry is bundled and surfaced to the app: metadata
 * for the picker, and lazily-compiled bot functions for play.
 */

import { getCommunityBotList, loadCommunityBot } from '../../src/arena/communityBots.js';
import { adaptModernBot } from '../../src/arena/modernBotAdapter.js';
import { runFullAITurn } from '../../src/engine/AIAdapter.js';
import { createGame } from '../../src/engine/GameRunner.js';
import { createBotState } from '../../src/arena/botState.js';

describe('getCommunityBotList', () => {
  it('returns metadata for the active registry bots', () => {
    const list = getCommunityBotList();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(3);

    for (const bot of list) {
      expect(typeof bot.id).toBe('string');
      expect(typeof bot.name).toBe('string');
      expect(bot.id.length).toBeGreaterThan(0);
      expect(bot.name.length).toBeGreaterThan(0);
    }
  });

  it('includes the known curated bots', () => {
    const ids = getCommunityBotList().map(b => b.id);
    expect(ids).toContain('bigintersmind/connector');
    expect(ids).toContain('bigintersmind/blitz');
    expect(ids).toContain('bigintersmind/giant-slayer');
  });
});

describe('loadCommunityBot', () => {
  it('compiles a bot into a callable modern function that returns a move or null', () => {
    const fn = loadCommunityBot('bigintersmind/connector');
    expect(typeof fn).toBe('function');

    const state = createGame({ seed: 7, playerCount: 4 });
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const move = fn(createBotState(state, playerId));

    if (move !== null) {
      expect(typeof move.from).toBe('number');
      expect(typeof move.to).toBe('number');
    }
  });

  it('memoizes the compiled function (same reference on repeat)', () => {
    const a = loadCommunityBot('bigintersmind/blitz');
    const b = loadCommunityBot('bigintersmind/blitz');
    expect(a).toBe(b);
  });

  it('throws on an unknown id', () => {
    expect(() => loadCommunityBot('nobody/does-not-exist')).toThrow(/Unknown community bot/);
  });
});

describe('community bot in the in-game loop (end-to-end)', () => {
  it('plays a full turn through the modern adapter + engine without throwing', () => {
    const aiFn = adaptModernBot(loadCommunityBot('bigintersmind/connector'), 'Connector');
    expect(aiFn.__modernBot).toBe(true);

    const state = createGame({ seed: 9, playerCount: 4 });
    const next = runFullAITurn(state, aiFn);

    // The turn completes and advances the game (END_TURN at minimum).
    expect(next).toBeDefined();
    expect(next.history.length).toBeGreaterThan(state.history.length);
  });
});
