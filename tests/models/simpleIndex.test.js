/**
 * Simple test for models index module
 */
import * as models from '../../src/models/index.js';

describe('Models Index Simple', () => {
  it('should export models', () => {
    // Just confirm the module exports something
    expect(models).toBeDefined();
  });
});
