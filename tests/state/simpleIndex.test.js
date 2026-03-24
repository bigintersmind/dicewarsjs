/**
 * Simple test for state index module
 */
import * as state from '../../src/state/index.js';

describe('State Index Simple', () => {
  it('should export state modules', () => {
    // Just confirm the module exports something
    expect(state).toBeDefined();
  });
});
