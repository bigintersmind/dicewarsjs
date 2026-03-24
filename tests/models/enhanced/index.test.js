/**
 * Tests for enhanced models index module
 */
import * as enhanced from '../../../src/models/enhanced/index.js';

describe('Enhanced Models Index Module', () => {
  it('should export all enhanced model classes', () => {
    // Test that all enhanced model classes are exported
    expect(typeof enhanced.AreaData).toBe('function');
    expect(typeof enhanced.PlayerData).toBe('function');
    expect(typeof enhanced.GridData).toBe('function');
    expect(typeof enhanced.AdjacencyGraph).toBe('function');
    expect(typeof enhanced.DisjointSet).toBe('function');
    expect(typeof enhanced.TerritoryGraph).toBe('function');
  });
});
