/**
 * Tests for state index module
 */
import * as state from '../../src/state/index.js';

describe('State Index Module', () => {
  it('should export all state management components', () => {
    // Core state management exports
    expect(state.GameState).toBeDefined();
    expect(typeof state.createInitialState).toBe('function');

    // Entity state exports
    expect(state.TerritoryState).toBeDefined();
    expect(state.PlayerState).toBeDefined();

    // Utility function exports
    expect(typeof state.updateObject).toBe('function');
    expect(typeof state.deepFreeze).toBe('function');
    expect(typeof state.immutable).toBe('function');
    // Check for actual exports from ImmutableUtils
    expect(typeof state.updateArrayItem).toBe('function');
    expect(typeof state.addArrayItem).toBe('function');
    expect(typeof state.removeArrayItem).toBe('function');
    expect(typeof state.filterArray).toBe('function');
    expect(typeof state.mapArray).toBe('function');
    expect(typeof state.updateMap).toBe('function');
    expect(typeof state.deleteMapEntry).toBe('function');
    expect(typeof state.addSetItem).toBe('function');
    expect(typeof state.deleteSetItem).toBe('function');
  });
});
