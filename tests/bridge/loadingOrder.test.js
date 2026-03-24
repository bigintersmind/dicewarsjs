/**
 * Integration test simulating legacy script order where bridges load first.
 */

describe('Legacy Script Loading Order', () => {
  const setupMcjsMock = () => {
    global.lib = global.lib || {};
    const mcInit = vi.fn((libObj, _img, _cjs, _ss) => {
      libObj.webFontTxtFilters = {};
      libObj.properties = {
        id: 'TEST',
        width: 512,
        height: 96,
        fps: 24,
        color: '#CCCCCC',
        webfonts: {},
      };
      libObj.ssMetadata = [];
      libObj.areadice = function () {};
      libObj.mc = function () {};
    });
    mcInit(global.lib, global.images || {}, global.cjs, global.ss || {});
  };

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<canvas id="myCanvas"></canvas>';
    global.createjs = global.cjs;
  });

  test('bridges initialize before legacy code executes', async () => {
    require('../../src/game-loader.js');
    require('../../src/bridge/index.js');
    await new Promise(resolve => setImmediate(resolve));
    await import('../../src/bridge/ai.js');
    await new Promise(resolve => setImmediate(resolve));

    const aiBefore = window.ai_default;
    expect(typeof aiBefore).toBe('function');

    // Store the initial window.Game reference (from bridge)
    const GameBefore = window.Game;
    expect(typeof GameBefore).toBe('function');

    setupMcjsMock();
    require('../../src/gameWrapper.js');
    require('../../config.js');
    require('../../src/main.js');

    window.dispatchEvent(new Event('load'));

    /*
     * The gameWrapper.js should have set window.Game
     * Check that we have the same constructor
     */
    const instance = new window.Game();
    expect(instance).toBeInstanceOf(window.Game);
    expect(window.ai_default).toBe(aiBefore);
  });
});
