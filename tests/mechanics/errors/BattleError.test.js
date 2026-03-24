import { BattleError } from '../../../src/mechanics/errors/BattleError.js';
import { gameEvents } from '../../../src/mechanics/eventSystem.js';

vi.mock('../../../src/mechanics/eventSystem.js', () => ({
  gameEvents: {
    emit: vi.fn(),
  },
  EventType: {
    CUSTOM: 'custom',
  },
}));

describe('BattleError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a BattleError with message and area information', () => {
      const error = new BattleError('Invalid battle', 5, 10);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('BattleError');
      expect(error.message).toBe('Invalid battle');
      expect(error.code).toBe('ERR_BATTLE');
      expect(error.data).toEqual({ fromArea: 5, toArea: 10 });
    });

    it('should create a BattleError with additional data', () => {
      const additionalData = { reason: 'not adjacent' };
      const error = new BattleError('Invalid battle', 5, 10, additionalData);

      expect(error.data).toEqual({
        fromArea: 5,
        toArea: 10,
        reason: 'not adjacent',
      });
    });

    it('should emit an error event when created', () => {
      const error = new BattleError('Test battle error', 3, 7);

      expect(gameEvents.emit).toHaveBeenCalledTimes(1);
      expect(gameEvents.emit).toHaveBeenCalledWith(expect.any(String), {
        type: 'error',
        error: {
          name: 'BattleError',
          message: 'Test battle error',
          code: 'ERR_BATTLE',
          data: { fromArea: 3, toArea: 7 },
        },
      });
    });
  });

  describe('toString', () => {
    it('should return formatted error string', () => {
      const error = new BattleError('Battle failed', 1, 2);
      const errorString = error.toString();

      expect(errorString).toBe('BattleError [ERR_BATTLE]: Battle failed');
    });
  });
});
