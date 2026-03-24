import { TerritoryError } from '../../../src/mechanics/errors/TerritoryError.js';
import { gameEvents } from '../../../src/mechanics/eventSystem.js';

vi.mock('../../../src/mechanics/eventSystem.js', () => ({
  gameEvents: {
    emit: vi.fn(),
  },
  EventType: {
    CUSTOM: 'custom',
  },
}));

describe('TerritoryError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a TerritoryError with message and territory ID', () => {
      const error = new TerritoryError('Invalid territory', 42);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('TerritoryError');
      expect(error.message).toBe('Invalid territory');
      expect(error.code).toBe('ERR_TERRITORY');
      expect(error.data).toEqual({ territoryId: 42 });
    });

    it('should create a TerritoryError with additional data', () => {
      const additionalData = { owner: 1, dice: 3 };
      const error = new TerritoryError('Territory occupied', 42, additionalData);

      expect(error.data).toEqual({
        territoryId: 42,
        owner: 1,
        dice: 3,
      });
    });

    it('should emit an error event when created', () => {
      const error = new TerritoryError('Territory error', 15);

      expect(gameEvents.emit).toHaveBeenCalledTimes(1);
      expect(gameEvents.emit).toHaveBeenCalledWith(expect.any(String), {
        type: 'error',
        error: {
          name: 'TerritoryError',
          message: 'Territory error',
          code: 'ERR_TERRITORY',
          data: { territoryId: 15 },
        },
      });
    });
  });

  describe('toString', () => {
    it('should return formatted error string', () => {
      const error = new TerritoryError('Territory not found', 10);
      const errorString = error.toString();

      expect(errorString).toBe('TerritoryError [ERR_TERRITORY]: Territory not found');
    });
  });
});
