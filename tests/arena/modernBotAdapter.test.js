/**
 * Modern bot adapter tests
 *
 * The reverse of legacyBotAdapter: wraps a modern `(BotState) => {from,to}|null`
 * bot so the in-game `runAI(state, fn)` loop can drive it.
 */

import { adaptModernBot } from '../../src/arena/modernBotAdapter.js';
import { runAI } from '../../src/engine/AIAdapter.js';
import { createGame } from '../../src/engine/GameRunner.js';

describe('adaptModernBot', () => {
  it('tags the wrapped function as a modern bot and preserves the name', () => {
    const wrapped = adaptModernBot(() => null, 'my_bot');
    expect(wrapped.__modernBot).toBe(true);
    expect(wrapped.name).toBe('my_bot');
  });

  it('builds a BotState for the current player and returns its move', () => {
    const state = createGame({ seed: 11, playerCount: 4 });
    const expectedPlayer = state.turnOrder[state.currentPlayerIndex];

    let seenPlayer = null;
    const wrapped = adaptModernBot(botState => {
      seenPlayer = botState.myPlayer;
      // BotState must be the sanitized arena projection, not a legacy view.
      expect(Array.isArray(botState.allAreas)).toBe(true);
      expect(typeof botState.turnNumber).toBe('number');
      return { from: 5, to: 6 };
    }, 'probe');

    const move = wrapped(state);
    expect(seenPlayer).toBe(expectedPlayer);
    expect(move).toEqual({ from: 5, to: 6 });
  });

  it('returns null when the bot returns null (ends turn)', () => {
    const state = createGame({ seed: 11, playerCount: 2 });
    const wrapped = adaptModernBot(() => null);
    expect(wrapped(state)).toBeNull();
  });

  it('returns null and does not throw when the bot throws', () => {
    const state = createGame({ seed: 11, playerCount: 2 });
    const wrapped = adaptModernBot(() => {
      throw new Error('boom');
    }, 'thrower');
    expect(wrapped(state)).toBeNull();
  });

  it('returns null for a malformed move', () => {
    const state = createGame({ seed: 11, playerCount: 2 });
    const wrapped = adaptModernBot(() => ({ from: 'x' }));
    expect(wrapped(state)).toBeNull();
  });
});

describe('runAI routing for modern bots', () => {
  it('calls a __modernBot function with engine state (not a legacy view)', () => {
    const state = createGame({ seed: 3, playerCount: 3 });

    let argued = null;
    const wrapped = adaptModernBot(botState => {
      argued = botState;
      return { from: 2, to: 3 };
    });

    const move = runAI(state, wrapped);
    /*
     * The bot receives a sanitized BotState (has myPlayer/turnNumber), not the
     * legacy mutable view (which has adat/jun/get_pn).
     */
    expect(argued).toHaveProperty('myPlayer');
    expect(argued.get_pn).toBeUndefined();
    expect(move).toEqual({ from: 2, to: 3 });
  });

  it('treats a non-positive move as end-of-turn', () => {
    const state = createGame({ seed: 3, playerCount: 2 });
    const wrapped = adaptModernBot(() => ({ from: 0, to: 0 }));
    expect(runAI(state, wrapped)).toBeNull();
  });
});
