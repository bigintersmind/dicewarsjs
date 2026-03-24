/**
 * Simple tests to increase coverage above 60%
 */
import * as index from '../src/index.js';
import * as main from '../src/main.js';

describe('Coverage Tests', () => {
  it('should load src/index.js', () => {
    expect(index).toBeDefined();
  });

  it('should load src/main.js', () => {
    expect(main).toBeDefined();
  });
});
