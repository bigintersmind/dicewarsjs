import { GameError } from '../../../src/mechanics/errors/GameError.js';
import { gameEvents, EventType } from '../../../src/mechanics/eventSystem.js';

vi.mock('../../../src/mechanics/eventSystem.js', () => ({
  gameEvents: {
    emit: vi.fn(),
  },
  EventType: {
    CUSTOM: 'custom',
  },
}));

describe('GameError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a GameError with message and code', () => {
      const error = new GameError('Test error message', 'TEST_ERROR');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('GameError');
      expect(error.message).toBe('Test error message');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.data).toEqual({});
      expect(error.timestamp).toBeGreaterThan(0);
    });

    it('should create a GameError with custom data', () => {
      const customData = { playerId: 1, areaId: 42 };
      const error = new GameError('Test error', 'TEST_ERROR', customData);

      expect(error.data).toEqual(customData);
    });

    it('should emit an error event when created', () => {
      const error = new GameError('Test error', 'TEST_ERROR', { test: true });

      expect(gameEvents.emit).toHaveBeenCalledTimes(1);
      expect(gameEvents.emit).toHaveBeenCalledWith(EventType.CUSTOM, {
        type: 'error',
        error: {
          name: 'GameError',
          message: 'Test error',
          code: 'TEST_ERROR',
          data: { test: true },
        },
      });
    });
  });

  describe('toString', () => {
    it('should return formatted error string', () => {
      const error = new GameError('Test error message', 'TEST_ERROR');
      const errorString = error.toString();

      expect(errorString).toBe('GameError [TEST_ERROR]: Test error message');
    });
  });
});
