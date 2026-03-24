/**
 * Tests for mechanics index module
 */
import * as mechanics from '../../src/mechanics/index.js';

describe('Mechanics Index Module', () => {
  it('should export all game mechanics functions', () => {
    // Map generator exports
    expect(typeof mechanics.percolate).toBe('function');
    expect(typeof mechanics.setAreaLine).toBe('function');
    expect(typeof mechanics.makeMap).toBe('function');
    expect(typeof mechanics.setAreaTc).toBe('function');

    // Battle resolution exports
    expect(typeof mechanics.rollDice).toBe('function');
    expect(typeof mechanics.calculateAttackProbability).toBe('function');
    expect(typeof mechanics.resolveBattle).toBe('function');
    expect(typeof mechanics.executeAttack).toBe('function');
    expect(typeof mechanics.distributeReinforcements).toBe('function');
    expect(typeof mechanics.setPlayerTerritoryData).toBe('function');

    // AI handler exports
    expect(typeof mechanics.generatePossibleMoves).toBe('function');
    expect(typeof mechanics.executeAIMove).toBe('function');
    expect(typeof mechanics.configureAI).toBe('function');

    // Error handling exports
    expect(typeof mechanics.validateTerritories).toBe('function');
    expect(typeof mechanics.validatePlayer).toBe('function');
    expect(typeof mechanics.withErrorHandling).toBe('function');
    expect(typeof mechanics.getUserFriendlyErrorMessage).toBe('function');

    // Event system exports
    expect(typeof mechanics.gameEvents).toBe('object');
    expect(typeof mechanics.EventType).toBe('object');
    expect(typeof mechanics.getTerritoryEventData).toBe('function');
    expect(typeof mechanics.emitTerritoryAttack).toBe('function');
    expect(typeof mechanics.emitTerritoryCapture).toBe('function');
    expect(typeof mechanics.emitDiceRolled).toBe('function');
    expect(typeof mechanics.emitTerritoryReinforced).toBe('function');
    expect(typeof mechanics.handleGlobalError).toBe('function');
  });
});
