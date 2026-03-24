/**
 * Global Exports Tests for Bridge Modules
 */

describe('Bridge Module Global Exports', () => {
  beforeEach(() => {
    vi.resetModules();
    global.window = global.window || {};
    global.process = global.process || { env: { NODE_ENV: 'development' } };
  });

  test('Game bridge exposes Game class globally', () => {
    require('../../src/bridge/Game.js');
    const { Game } = require('../../src/Game.js');
    expect(window.Game).toBe(Game);
  });

  test('AI bridge exposes AI functions globally', async () => {
    await import('../../src/bridge/ai.js');
    await new Promise(resolve => setImmediate(resolve));

    expect(typeof window.ai_default).toBe('function');
    expect(typeof window.ai_defensive).toBe('function');
    expect(typeof window.ai_example).toBe('function');
    expect(typeof window.ai_adaptive).toBe('function');
  });

  // The remaining bridge modules expose Game and AI functionality
});
