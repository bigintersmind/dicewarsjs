/**
 * Tests for models index module
 */
import * as models from '../../src/models/index.js';

describe('Models Index Module', () => {
  it('should export all model classes', () => {
    // Test that all model classes are exported
    expect(typeof models.AreaData).toBe('function');
    expect(typeof models.PlayerData).toBe('function');
    expect(typeof models.JoinData).toBe('function');
    expect(typeof models.HistoryData).toBe('function');
    expect(typeof models.Battle).toBe('function');
  });

  it('should create instances of model classes', () => {
    const { AreaData, PlayerData, JoinData, HistoryData, Battle } = models;

    // Test that we can create instances
    expect(new AreaData()).toBeDefined();
    expect(new PlayerData()).toBeDefined();
    expect(new JoinData()).toBeDefined();
    expect(new HistoryData()).toBeDefined();
    expect(new Battle()).toBeDefined();
  });
});
