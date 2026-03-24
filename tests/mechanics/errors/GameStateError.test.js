import { GameStateError } from '../../../src/mechanics/errors/GameStateError.js';
import { gameEvents } from '../../../src/mechanics/eventSystem.js';

vi.mock('../../../src/mechanics/eventSystem.js', () => ({
  gameEvents: {
    emit: vi.fn(),
  },
  EventType: {
    CUSTOM: 'custom',
  },
}));

describe('GameStateError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a GameStateError with message', () => {
      const error = new GameStateError('Invalid game state');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('GameStateError');
      expect(error.message).toBe('Invalid game state');
      expect(error.code).toBe('ERR_GAME_STATE');
      expect(error.data).toEqual({});
    });

    it('should create a GameStateError with custom data', () => {
      const customData = { state: 'finished', reason: 'game already over' };
      const error = new GameStateError('Cannot perform action', customData);

      expect(error.data).toEqual(customData);
    });

    it('should emit an error event when created', () => {
      const error = new GameStateError('State error', { turn: 10 });

      expect(gameEvents.emit).toHaveBeenCalledTimes(1);
      expect(gameEvents.emit).toHaveBeenCalledWith(expect.any(String), {
        type: 'error',
        error: {
          name: 'GameStateError',
          message: 'State error',
          code: 'ERR_GAME_STATE',
          data: { turn: 10 },
        },
      });
    });
  });

  describe('toString', () => {
    it('should return formatted error string', () => {
      const error = new GameStateError('Game not initialized');
      const errorString = error.toString();

      expect(errorString).toBe('GameStateError [ERR_GAME_STATE]: Game not initialized');
    });
  });
});
