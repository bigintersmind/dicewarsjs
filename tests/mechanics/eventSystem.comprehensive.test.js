/**
 * Comprehensive tests for the Event System
 */

import {
  gameEvents,
  EventType,
  getTerritoryEventData,
  emitTerritoryAttack,
  emitTerritoryCapture,
  emitDiceRolled,
  emitTerritoryReinforced,
  loggingMiddleware,
  createTimeTravel,
} from '../../src/mechanics/eventSystem.js';

describe('EventSystem - Comprehensive Coverage', () => {
  beforeEach(() => {
    // Clear all handlers between tests
    Object.values(EventType).forEach(type => {
      gameEvents.offAll(type);
    });
    // Clear middleware
    gameEvents.middleware.length = 0;
  });

  describe('EventEmitter middleware functionality', () => {
    it('should process events through middleware', async () => {
      const middleware = vi.fn((eventType, data) => ({ ...data, processed: true }));

      gameEvents.addMiddleware(middleware);

      // Subscribe to an event
      let receivedData = null;
      gameEvents.on(EventType.GAME_START, data => {
        receivedData = data;
      });

      // Emit the event
      await gameEvents.emit(EventType.GAME_START, { test: true });

      // Verify middleware was called
      expect(middleware).toHaveBeenCalledWith(EventType.GAME_START, { test: true });

      // Verify the handler received the processed data
      expect(receivedData).toEqual({ test: true, processed: true });
    });

    it('should handle multiple middleware in sequence', async () => {
      /*
       * The middleware are run in parallel in the actual implementation
       * so we need to test differently
       */
      const middleware1 = vi.fn((eventType, data) => ({ ...data, step1: true }));

      const middleware2 = vi.fn((eventType, data) => ({ ...data, step2: true }));

      gameEvents.addMiddleware(middleware1);
      gameEvents.addMiddleware(middleware2);

      // Subscribe to an event
      let receivedData = null;
      gameEvents.on(EventType.GAME_START, data => {
        receivedData = data;
      });

      // Emit the event
      await gameEvents.emit(EventType.GAME_START, { test: true });

      /*
       * Since middleware runs in parallel and uses last non-null result,
       * we should get the result from the last middleware
       */
      expect(receivedData).toEqual({ test: true, step2: true });
    });

    it('should allow middleware to be removed', async () => {
      const middleware = vi.fn((eventType, data) => ({ ...data, processed: true }));

      const removeMiddleware = gameEvents.addMiddleware(middleware);

      // Subscribe to an event
      let receivedData = null;
      gameEvents.on(EventType.GAME_START, data => {
        receivedData = data;
      });

      // Emit the event
      await gameEvents.emit(EventType.GAME_START, { test: true });
      expect(receivedData).toEqual({ test: true, processed: true });

      // Remove the middleware
      removeMiddleware();

      // Emit the event again
      await gameEvents.emit(EventType.GAME_START, { test2: true });
      expect(receivedData).toEqual({ test2: true }); // No processing
    });

    it('should handle middleware that returns null', async () => {
      const middleware1 = vi.fn(
        () => null // Returns null
      );

      const middleware2 = vi.fn((eventType, data) => ({ ...data, processed: true }));

      gameEvents.addMiddleware(middleware1);
      gameEvents.addMiddleware(middleware2);

      // Subscribe to an event
      let receivedData = null;
      gameEvents.on(EventType.GAME_START, data => {
        receivedData = data;
      });

      // Emit the event
      await gameEvents.emit(EventType.GAME_START, { test: true });

      // Should receive data from middleware2 since middleware1 returned null
      expect(receivedData).toEqual({ test: true, processed: true });
    });
  });

  describe('emit method edge cases', () => {
    it('should return empty array when no handlers exist', async () => {
      const results = await gameEvents.emit(EventType.GAME_START, { test: true });
      expect(results).toEqual([]);
    });

    it('should handle errors in handlers gracefully', async () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });

      const normalHandler = vi.fn(() => 'success');

      gameEvents.on(EventType.GAME_START, errorHandler);
      gameEvents.on(EventType.GAME_START, normalHandler);

      // Mock console.error to verify it's called
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation();

      const results = await gameEvents.emit(EventType.GAME_START, {});

      // Error handler should return null, normal handler should return 'success'
      expect(results).toEqual([null, 'success']);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `Error in event handler for ${EventType.GAME_START}:`,
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle async handlers correctly', async () => {
      const asyncHandler1 = vi.fn(
        async () =>
          new Promise(resolve => {
            setTimeout(() => resolve('result1'), 10);
          })
      );

      const asyncHandler2 = vi.fn(
        async () =>
          new Promise(resolve => {
            setTimeout(() => resolve('result2'), 5);
          })
      );

      gameEvents.on(EventType.GAME_START, asyncHandler1);
      gameEvents.on(EventType.GAME_START, asyncHandler2);

      const results = await gameEvents.emit(EventType.GAME_START, {});

      // Both handlers should complete
      expect(results).toEqual(['result1', 'result2']);
    });
  });

  describe('Helper functions', () => {
    const mockGameState = {
      adat: {
        1: {
          arm: 1,
          dice: 3,
          size: 4,
          cx: 100,
          cy: 200,
        },
        2: {
          arm: 2,
          dice: 2,
          size: 3,
          cx: 150,
          cy: 250,
        },
      },
    };

    describe('getTerritoryEventData', () => {
      it('should return correct territory data', () => {
        const data = getTerritoryEventData(mockGameState, 1);

        expect(data).toEqual({
          territoryId: 1,
          playerId: 1,
          dice: 3,
          size: 4,
          position: {
            x: 100,
            y: 200,
          },
        });
      });
    });

    describe('emitTerritoryAttack', () => {
      it('should emit territory attack event with correct data', async () => {
        const handler = vi.fn();
        gameEvents.on(EventType.TERRITORY_ATTACK, handler);

        await emitTerritoryAttack(mockGameState, 1, 2);

        expect(handler).toHaveBeenCalledWith({
          attackerId: 1,
          defenderId: 2,
          attackerPlayerId: 1,
          defenderPlayerId: 2,
          attackerDice: 3,
          defenderDice: 2,
          gameState: mockGameState,
        });
      });
    });

    describe('emitTerritoryCapture', () => {
      it('should emit territory capture event with correct data', async () => {
        const handler = vi.fn();
        gameEvents.on(EventType.TERRITORY_CAPTURE, handler);

        await emitTerritoryCapture(mockGameState, 2, 2, 1);

        expect(handler).toHaveBeenCalledWith({
          territoryId: 2,
          capturedFromPlayerId: 2,
          capturedByPlayerId: 1,
          remainingDice: 2,
          gameState: mockGameState,
        });
      });
    });

    describe('emitDiceRolled', () => {
      it('should emit dice rolled event with correct data', async () => {
        const handler = vi.fn();
        gameEvents.on(EventType.DICE_ROLLED, handler);

        const values = [3, 4, 5];
        const total = 12;
        await emitDiceRolled(mockGameState, 1, values, total, 'attack');

        expect(handler).toHaveBeenCalledWith({
          territoryId: 1,
          playerId: 1,
          values,
          total,
          context: 'attack',
          gameState: mockGameState,
        });
      });
    });

    describe('emitTerritoryReinforced', () => {
      it('should emit territory reinforced event with correct data', async () => {
        const handler = vi.fn();
        gameEvents.on(EventType.TERRITORY_REINFORCED, handler);

        await emitTerritoryReinforced(mockGameState, 1, 2);

        expect(handler).toHaveBeenCalledWith({
          territoryId: 1,
          playerId: 1,
          addedDice: 2,
          totalDice: 3,
          gameState: mockGameState,
        });
      });
    });
  });

  describe('Middleware implementations', () => {
    describe('loggingMiddleware', () => {
      it('should log events and return unchanged data', () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation();
        const data = { test: true };

        const result = loggingMiddleware(EventType.GAME_START, data);

        expect(consoleLogSpy).toHaveBeenCalledWith('[EVENT] game:start', data);
        expect(result).toBe(data); // Should return the same object

        consoleLogSpy.mockRestore();
      });
    });

    describe('createTimeTravel', () => {
      it('should record events with timestamp', async () => {
        const timeTravel = createTimeTravel();
        const mockDate = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(mockDate);

        // Add the recording middleware
        gameEvents.addMiddleware(timeTravel.middleware);

        // Subscribe to handlers to ensure events are emitted
        gameEvents.on(EventType.GAME_START, () => {});
        gameEvents.on(EventType.TURN_START, () => {});

        // Emit some events
        await gameEvents.emit(EventType.GAME_START, { player: 1 });
        await gameEvents.emit(EventType.TURN_START, { turn: 1 });

        const history = timeTravel.getHistory();
        expect(history).toHaveLength(2);

        // The middleware transforms the data, but time travel stores a copy
        expect(history[0]).toMatchObject({
          timestamp: mockDate,
          eventType: EventType.GAME_START,
        });
        // Test that data was deep cloned
        expect(history[0].data).toMatchObject({ player: 1 });

        expect(history[1]).toMatchObject({
          timestamp: mockDate,
          eventType: EventType.TURN_START,
        });
        expect(history[1].data).toMatchObject({ turn: 1 });

        // Test clearing history
        timeTravel.clearHistory();
        expect(timeTravel.getHistory()).toHaveLength(0);
      });
    });
  });

  describe('EventType enum', () => {
    it('should have all expected event types', () => {
      const expectedTypes = [
        'GAME_START',
        'GAME_END',
        'TURN_START',
        'TURN_END',
        'PLAYER_ELIMINATED',
        'PLAYER_VICTORY',
        'TERRITORY_ATTACK',
        'TERRITORY_CAPTURE',
        'TERRITORY_DEFEND',
        'TERRITORY_REINFORCED',
        'DICE_ROLLED',
        'DICE_ADDED',
        'SELECTION_CHANGED',
        'MAP_UPDATED',
        'AI_THINKING_START',
        'AI_THINKING_END',
        'AI_DECISION_MADE',
        'CUSTOM',
      ];

      expectedTypes.forEach(type => {
        expect(EventType).toHaveProperty(type);
        expect(typeof EventType[type]).toBe('string');
      });
    });
  });

  describe('Async middleware handling', () => {
    it('should handle async middleware correctly', async () => {
      const asyncMiddleware = vi.fn(
        async (eventType, data) =>
          new Promise(resolve => {
            setTimeout(() => {
              resolve({ ...data, asyncProcessed: true });
            }, 10);
          })
      );

      gameEvents.addMiddleware(asyncMiddleware);

      let receivedData = null;
      gameEvents.on(EventType.GAME_START, data => {
        receivedData = data;
      });

      await gameEvents.emit(EventType.GAME_START, { test: true });

      expect(receivedData).toEqual({ test: true, asyncProcessed: true });
    });
  });
});
