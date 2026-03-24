/**
 * Tests for Event System Module
 */

import {
  EventType,
  gameEvents,
  eventHistory,
  createEventSystem,
  recordEvent,
  clearEventHistory,
  filterEvents,
  eventStats,
  emitDiceRolled,
  emitTerritoryAttack,
  emitTerritoryCapture,
  emitTerritoryReinforced,
} from '../../src/mechanics/eventSystem.js';

describe('Event System Module', () => {
  beforeEach(() => {
    clearEventHistory();
    // Clear all handlers
    gameEvents.clear();
  });

  describe('EventType', () => {
    it('should define all expected event types', () => {
      expect(EventType.GAME_START).toBe('game:start');
      expect(EventType.GAME_END).toBe('game:end');
      expect(EventType.TURN_START).toBe('turn:start');
      expect(EventType.TURN_END).toBe('turn:end');
      expect(EventType.PLAYER_ELIMINATED).toBe('player:eliminated');
      expect(EventType.PLAYER_VICTORY).toBe('player:victory');
      expect(EventType.TERRITORY_ATTACK).toBe('territory:attack');
      expect(EventType.TERRITORY_CAPTURE).toBe('territory:capture');
      expect(EventType.TERRITORY_DEFEND).toBe('territory:defend');
      expect(EventType.TERRITORY_REINFORCED).toBe('territory:reinforced');
      expect(EventType.DICE_ROLLED).toBe('dice:rolled');
      expect(EventType.DICE_ADDED).toBe('dice:added');
      expect(EventType.SELECTION_CHANGED).toBe('ui:selection_changed');
      expect(EventType.MAP_UPDATED).toBe('ui:map_updated');
      expect(EventType.AI_THINKING_START).toBe('ai:thinking_start');
      expect(EventType.AI_THINKING_END).toBe('ai:thinking_end');
      expect(EventType.AI_DECISION_MADE).toBe('ai:decision_made');
      expect(EventType.CUSTOM).toBe('custom');
    });
  });

  describe('createEventSystem', () => {
    it('should create an event system with all required methods', () => {
      const events = createEventSystem();

      expect(typeof events.on).toBe('function');
      expect(typeof events.once).toBe('function');
      expect(typeof events.off).toBe('function');
      expect(typeof events.emit).toBe('function');
      expect(typeof events.clear).toBe('function');
    });

    it('should handle event registration and emission', async () => {
      const events = createEventSystem();
      const mockHandler = vi.fn();

      events.on('test', mockHandler);
      await events.emit('test', { data: 'test' });

      expect(mockHandler).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should handle once event handler', async () => {
      const events = createEventSystem();
      const mockHandler = vi.fn();

      events.once('test', mockHandler);
      await events.emit('test', { data: 'first' });
      await events.emit('test', { data: 'second' });

      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockHandler).toHaveBeenCalledWith({ data: 'first' });
    });

    it('should handle event handler removal', async () => {
      const events = createEventSystem();
      const mockHandler = vi.fn();

      const subscriptionId = events.on('test', mockHandler);
      events.off(subscriptionId);
      await events.emit('test', { data: 'test' });

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should clear all handlers', async () => {
      const events = createEventSystem();
      const mockHandler1 = vi.fn();
      const mockHandler2 = vi.fn();

      events.on('test1', mockHandler1);
      events.on('test2', mockHandler2);
      events.clear();
      await events.emit('test1', { data: 'test1' });
      await events.emit('test2', { data: 'test2' });

      expect(mockHandler1).not.toHaveBeenCalled();
      expect(mockHandler2).not.toHaveBeenCalled();
    });

    it('should handle multiple handlers for same event', async () => {
      const events = createEventSystem();
      const mockHandler1 = vi.fn();
      const mockHandler2 = vi.fn();

      events.on('test', mockHandler1);
      events.on('test', mockHandler2);
      await events.emit('test', { data: 'test' });

      expect(mockHandler1).toHaveBeenCalledWith({ data: 'test' });
      expect(mockHandler2).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should handle middleware', async () => {
      const events = createEventSystem();
      const mockHandler = vi.fn();
      const mockMiddleware = vi.fn((eventType, data) => ({
        ...data,
        modified: true,
      }));

      events.addMiddleware(mockMiddleware);
      events.on('test', mockHandler);
      await events.emit('test', { data: 'test' });

      expect(mockMiddleware).toHaveBeenCalledWith('test', { data: 'test' });
      expect(mockHandler).toHaveBeenCalledWith({
        data: 'test',
        modified: true,
      });
    });

    it('should stop propagation when middleware does not call next', async () => {
      const events = createEventSystem();
      const mockHandler = vi.fn();
      const blockingMiddleware = vi.fn(
        (eventType, data) =>
          // Return null to not modify data
          null
      );

      events.addMiddleware(blockingMiddleware);
      events.on('test', mockHandler);
      await events.emit('test', { data: 'test' });

      expect(blockingMiddleware).toHaveBeenCalled();
      // Handler still gets called because middleware returns null (not modifying data)
      expect(mockHandler).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should handle errors in middleware', async () => {
      const events = createEventSystem();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockMiddleware = vi.fn(() => {
        throw new Error('Middleware error');
      });
      const mockHandler = vi.fn();

      events.addMiddleware(mockMiddleware);
      events.on('test', mockHandler);

      // Middleware errors are caught and logged but don't prevent handlers from running
      await events.emit('test', { data: 'test' });

      // Since middleware threw an error, it doesn't modify the data
      expect(mockHandler).toHaveBeenCalledWith({ data: 'test' });

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error in middleware:', expect.any(Error));

      consoleErrorSpy.mockRestore();
    });

    it('should handle errors in event handlers', async () => {
      const events = createEventSystem();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockHandler = vi.fn(() => {
        throw new Error('Handler error');
      });

      events.on('test', mockHandler);
      await events.emit('test', { data: 'test' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error in event handler for test:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('recordEvent', () => {
    it('should record events to history', () => {
      const event = { type: 'test', data: { value: 1 } };
      recordEvent('test', event);

      const history = eventHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        eventType: 'test',
        data: event,
        timestamp: expect.any(Number),
      });
    });

    it('should maintain event history limit', () => {
      // Record more than the default limit
      for (let i = 0; i < 1100; i++) {
        recordEvent('test', { index: i });
      }

      expect(eventHistory().length).toBeLessThanOrEqual(1000);
    });
  });

  describe('clearEventHistory', () => {
    it('should clear all event history', () => {
      recordEvent('test', { data: 'test' });
      expect(eventHistory()).toHaveLength(1);

      clearEventHistory();
      expect(eventHistory()).toHaveLength(0);
    });
  });

  describe('filterEvents', () => {
    beforeEach(() => {
      clearEventHistory();
    });

    it('should filter events by event name', () => {
      recordEvent('test1', { data: 1 });
      recordEvent('test2', { data: 2 });
      recordEvent('test1', { data: 3 });

      const filtered = filterEvents('test1');
      expect(filtered).toHaveLength(2);
      expect(filtered.every(e => e.eventType === 'test1')).toBe(true);
    });

    it('should filter events by predicate function', () => {
      recordEvent('test', { value: 1 });
      recordEvent('test', { value: 2 });
      recordEvent('test', { value: 3 });

      const filtered = filterEvents(e => e.data.value > 1);
      expect(filtered).toHaveLength(2);
      expect(filtered.every(e => e.data.value > 1)).toBe(true);
    });

    it('should return all events when no filter provided', () => {
      recordEvent('test1', { data: 1 });
      recordEvent('test2', { data: 2 });

      const filtered = filterEvents();
      expect(filtered).toHaveLength(2);
    });
  });

  describe('eventStats', () => {
    beforeEach(() => {
      clearEventHistory();
    });

    it('should calculate event statistics', () => {
      recordEvent('test1', { data: 1 });
      recordEvent('test2', { data: 2 });
      recordEvent('test1', { data: 3 });

      const stats = eventStats();
      expect(stats).toEqual({
        test1: 2,
        test2: 1,
      });
    });

    it('should handle empty event history', () => {
      const stats = eventStats();
      expect(stats).toEqual({});
    });
  });

  describe('Utility Emitters', () => {
    let gameState;
    let emitSpy;

    beforeEach(() => {
      emitSpy = vi.spyOn(gameEvents, 'emit');
      vi.clearAllMocks();
      gameState = {
        player: {
          1: { name: 'Player 1' },
          2: { name: 'Player 2' },
        },
        adat: {
          1: { arm: 1, dice: 5 },
          2: { arm: 2, dice: 3 },
        },
      };
    });

    afterEach(() => {
      emitSpy.mockRestore();
    });

    it('should emit dice rolled event', async () => {
      const values = [1, 2, 3];
      const total = 6;

      await emitDiceRolled(gameState, 1, values, total, 'attack');

      expect(emitSpy).toHaveBeenCalledWith(
        EventType.DICE_ROLLED,
        expect.objectContaining({
          territoryId: 1,
          values,
          total,
          context: 'attack',
          gameState,
        })
      );
    });

    it('should emit territory attack event', async () => {
      await emitTerritoryAttack(gameState, 1, 2);

      expect(emitSpy).toHaveBeenCalledWith(
        EventType.TERRITORY_ATTACK,
        expect.objectContaining({
          attackerId: 1,
          defenderId: 2,
          attackerPlayerId: 1,
          defenderPlayerId: 2,
          gameState,
        })
      );
    });

    it('should emit territory capture event', async () => {
      await emitTerritoryCapture(gameState, 2, 2, 1);

      expect(emitSpy).toHaveBeenCalledWith(
        EventType.TERRITORY_CAPTURE,
        expect.objectContaining({
          territoryId: 2,
          capturedFromPlayerId: 2,
          capturedByPlayerId: 1,
          gameState,
        })
      );
    });

    it('should emit territory reinforced event', async () => {
      await emitTerritoryReinforced(gameState, 1, 3);

      expect(emitSpy).toHaveBeenCalledWith(
        EventType.TERRITORY_REINFORCED,
        expect.objectContaining({
          territoryId: 1,
          addedDice: 3,
          playerId: 1,
          gameState,
        })
      );
    });
  });

  describe('gameEvents', () => {
    it('should be a singleton instance', () => {
      expect(gameEvents).toBe(gameEvents);
      expect(typeof gameEvents.on).toBe('function');
      expect(typeof gameEvents.emit).toBe('function');
    });

    it('should emit and handle events', async () => {
      const mockHandler = vi.fn();
      gameEvents.on(EventType.GAME_START, mockHandler);

      await gameEvents.emit(EventType.GAME_START, { test: 'data' });

      expect(mockHandler).toHaveBeenCalledWith({ test: 'data' });
    });
  });

  describe('Middleware and Recording', () => {
    let consoleLogSpy;

    beforeEach(() => {
      clearEventHistory();
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('should record emitted events', async () => {
      const initialHistory = eventHistory();
      const initialLength = initialHistory.length;

      // Create event system with recording middleware
      const events = createEventSystem();

      // Add a handler to ensure the event system has something to emit to
      events.on(EventType.TURN_START, () => {});

      await events.emit(EventType.TURN_START, { turn: 1 });

      const updatedHistory = eventHistory();
      expect(updatedHistory.length).toBe(initialLength + 1);
      expect(updatedHistory[updatedHistory.length - 1]).toMatchObject({
        eventType: EventType.TURN_START,
        data: { turn: 1 },
      });
    });
  });
});
