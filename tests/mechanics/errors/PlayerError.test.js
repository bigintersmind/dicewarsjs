import { PlayerError } from '../../../src/mechanics/errors/PlayerError.js';
import { gameEvents } from '../../../src/mechanics/eventSystem.js';

vi.mock('../../../src/mechanics/eventSystem.js', () => ({
  gameEvents: {
    emit: vi.fn(),
  },
  EventType: {
    CUSTOM: 'custom',
  },
}));

describe('PlayerError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a PlayerError with message and player ID', () => {
      const error = new PlayerError('Invalid player', 3);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('PlayerError');
      expect(error.message).toBe('Invalid player');
      expect(error.code).toBe('ERR_PLAYER');
      expect(error.data).toEqual({ playerId: 3 });
    });

    it('should create a PlayerError with additional data', () => {
      const additionalData = { action: 'attack', reason: 'not their turn' };
      const error = new PlayerError('Invalid action', 1, additionalData);

      expect(error.data).toEqual({
        playerId: 1,
        action: 'attack',
        reason: 'not their turn',
      });
    });

    it('should emit an error event when created', () => {
      const error = new PlayerError('Player not found', 5);

      expect(gameEvents.emit).toHaveBeenCalledTimes(1);
      expect(gameEvents.emit).toHaveBeenCalledWith(expect.any(String), {
        type: 'error',
        error: {
          name: 'PlayerError',
          message: 'Player not found',
          code: 'ERR_PLAYER',
          data: { playerId: 5 },
        },
      });
    });
  });

  describe('toString', () => {
    it('should return formatted error string', () => {
      const error = new PlayerError('Invalid move', 2);
      const errorString = error.toString();

      expect(errorString).toBe('PlayerError [ERR_PLAYER]: Invalid move');
    });
  });
});
