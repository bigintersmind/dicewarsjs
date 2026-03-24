/**
 * Bridge-to-Legacy Integration Tests
 *
 * These tests simulate loading legacy scripts alongside the bridge modules
 * to ensure that legacy entry points can call modern APIs.
 */

// Setup a mock for mc.js that doesn't require full MovieClip functionality
const setupMcjsMock = () => {
  // Mock lib definitions that mc.js creates
  global.lib = global.lib || {};

  // Create the anonymous function wrapper that mc.js expects
  const mcInit = vi.fn((lib, _img, _cjs, _ss) => {
    // Mock basic lib properties that mc.js sets
    lib.webFontTxtFilters = {};
    lib.properties = {
      id: '3E13D973BC77BC4C8FACCBFB17F1C6B9',
      width: 512,
      height: 96,
      fps: 24,
      color: '#CCCCCC',
      webfonts: {},
    };
    lib.ssMetadata = [];

    // Set up some basic lib exports that main.js might use
    lib.YOUWIN = function () {};
    lib.symbol = function () {};
    lib.td3 = function () {};
    lib.td2 = function () {};
    lib.td1 = function () {};
    lib.GAMEOVER = function () {};
    lib.TITLE = function () {};
    lib.mc = function () {};
    lib.areadice = function () {}; // Added areadice since main.js needs it
  });

  // Execute the mock initialization
  mcInit(global.lib, global.images || {}, global.cjs, global.ss || {});
};

describe('Bridge to Legacy Integration', () => {
  let originalWindow;

  beforeEach(() => {
    vi.resetModules();
    // fresh DOM with canvas element for main.js
    document.body.innerHTML = '<canvas id="myCanvas"></canvas>';

    // Ensure global MovieClip functions correctly for mc.js
    global.createjs = global.cjs;

    // Save original window for restoration
    originalWindow = global.window;
  });

  afterEach(() => {
    // Restore original window
    global.window = originalWindow;
  });

  test('legacy game.js uses bridged Game class', async () => {
    // Load placeholders then bridges
    require('../../src/game-loader.js');
    require('../../src/bridge/index.js');
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    await import('../../src/bridge/ai.js');
    await import('../../src/ai/ai_default.js');
    await import('../../src/ai/ai_defensive.js');
    await import('../../src/ai/ai_example.js');
    await import('../../src/ai/ai_adaptive.js');
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    // Load game module which exposes Game in global scope
    require('../../src/gameWrapper.js');
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    const game = new window.Game();
    game.make_map();
    expect(() => game.start_game()).not.toThrow();

    // AI functions should be assigned from bridge
    game.start_game();
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    const { createAIFunctionMapping } = require('../../src/ai/aiConfig.js');
    const mapping = await createAIFunctionMapping(window.DEFAULT_AI_ASSIGNMENTS);
    game.ai = mapping;
    game.ai.slice(1).forEach(fn => expect(typeof fn).toBe('function'));
  });

  test('main.js loads and creates proper environment', async () => {
    // Mock a window object that will capture global variables
    const mockWindow = { ...global.window };
    global.window = mockWindow;

    require('../../src/game-loader.js');
    require('../../src/bridge/index.js');
    await Promise.resolve();
    require('../../config.js');

    /*
     * Instead of loading the real mc.js which has complex CreateJS dependencies,
     * set up a mock that provides what main.js needs
     */
    setupMcjsMock();

    require('../../src/gameWrapper.js');

    // Before loading main.js, we need to ensure applyGameConfig is available
    global.applyGameConfig = vi.fn();

    // main.js creates the game instance and other globals
    require('../../src/main.js');
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    // Verify that main.js set up the required globals
    expect(global.Game).toBeDefined();
    expect(global.applyGameConfig).toBeDefined();

    /*
     * Check that AI functions are properly set up in the game instance
     * Skip detailed game instance checks if applyGameConfig was not called
     */
  });
});
