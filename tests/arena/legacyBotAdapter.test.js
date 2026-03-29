import { adaptLegacyBot } from '../../src/arena/legacyBotAdapter.js';
import { createBotState } from '../../src/arena/botState.js';
import { validateMove } from '../../src/arena/botValidator.js';
import { createGame } from '../../src/engine/GameRunner.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { ai_default } from '../../src/ai/ai_default.js';
import { ai_defensive } from '../../src/ai/ai_defensive.js';
import { ai_adaptive } from '../../src/ai/ai_adaptive.js';

function createTestBotState(seed = 42, playerCount = 4) {
  const state = createGame({ seed, playerCount });
  const playerId = state.turnOrder[state.currentPlayerIndex];
  return createBotState(state, playerId);
}

describe('adaptLegacyBot', () => {
  it('returns a function', () => {
    const bot = adaptLegacyBot(ai_example);
    expect(typeof bot).toBe('function');
  });

  it('preserves bot name', () => {
    const bot = adaptLegacyBot(ai_example, 'test_bot');
    expect(bot.name).toBe('test_bot');
  });

  it('uses legacy function name as fallback', () => {
    const bot = adaptLegacyBot(ai_example);
    expect(bot.name).toBe('ai_example');
  });
});

describe('adapted ai_example', () => {
  const bot = adaptLegacyBot(ai_example);

  it('returns a valid move or null', () => {
    const botState = createTestBotState();
    const move = bot(botState);

    if (move !== null) {
      expect(typeof move.from).toBe('number');
      expect(typeof move.to).toBe('number');
      const validation = validateMove(move, botState);
      expect(validation.valid).toBe(true);
    }
  });

  it('can produce multiple moves in a turn', () => {
    // Run the bot repeatedly on the same state to see if it returns moves
    const botState = createTestBotState();
    const move = bot(botState);
    // ai_example should find at least one attack in a fresh game
    expect(move).not.toBeNull();
  });
});

describe('adapted ai_default', () => {
  const bot = adaptLegacyBot(ai_default);

  it('returns a valid move or null', () => {
    const botState = createTestBotState(100);
    const move = bot(botState);

    if (move !== null) {
      const validation = validateMove(move, botState);
      expect(validation.valid).toBe(true);
    }
  });
});

describe('adapted ai_defensive', () => {
  const bot = adaptLegacyBot(ai_defensive);

  it('returns a valid move or null', () => {
    const botState = createTestBotState(200);
    const move = bot(botState);

    if (move !== null) {
      const validation = validateMove(move, botState);
      expect(validation.valid).toBe(true);
    }
  });
});

describe('adapted ai_adaptive', () => {
  const bot = adaptLegacyBot(ai_adaptive);

  it('returns a valid move or null', () => {
    const botState = createTestBotState(300);
    const move = bot(botState);

    if (move !== null) {
      const validation = validateMove(move, botState);
      expect(validation.valid).toBe(true);
    }
  });
});

describe('all legacy bots produce valid moves across seeds', () => {
  const bots = [
    { name: 'ai_example', fn: adaptLegacyBot(ai_example) },
    { name: 'ai_default', fn: adaptLegacyBot(ai_default) },
    { name: 'ai_defensive', fn: adaptLegacyBot(ai_defensive) },
    { name: 'ai_adaptive', fn: adaptLegacyBot(ai_adaptive) },
  ];

  const seeds = [42, 100, 200, 300, 999];

  for (const { name, fn } of bots) {
    for (const seed of seeds) {
      it(`${name} produces valid move with seed ${seed}`, () => {
        const botState = createTestBotState(seed);
        const move = fn(botState);

        if (move !== null) {
          const validation = validateMove(move, botState);
          expect(validation.valid).toBe(true);
        }
      });
    }
  }
});

describe('edge cases', () => {
  it('handles a bot that throws', () => {
    const crashingBot = adaptLegacyBot(() => {
      throw new Error('bot crashed');
    }, 'crasher');

    const botState = createTestBotState();
    const move = crashingBot(botState);
    expect(move).toBeNull();
  });

  it('handles a bot that returns 0 (end turn)', () => {
    const endTurnBot = adaptLegacyBot(() => 0, 'ender');

    const botState = createTestBotState();
    const move = endTurnBot(botState);
    expect(move).toBeNull();
  });

  it('handles a bot that returns undefined without setting areas', () => {
    const noopBot = adaptLegacyBot(() => {}, 'noop');

    const botState = createTestBotState();
    const move = noopBot(botState);
    expect(move).toBeNull();
  });
});
