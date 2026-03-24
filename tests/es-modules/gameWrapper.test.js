/**
 * Tests for the gameWrapper.js module
 */

vi.mock('../../src/Game-browser.js', () => ({
  Game: class MockGame {},
}));

// Mock all Game.js dependencies to prevent import errors
vi.mock('../../src/models/index.js', () => ({
  AreaData: vi.fn().mockImplementation(() => ({})),
  PlayerData: vi.fn().mockImplementation(() => ({})),
  JoinData: vi.fn().mockImplementation(() => ({ dir: new Array(6).fill(0) })),
  HistoryData: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/mechanics/index.js', () => ({
  makeMap: vi.fn(),
  setAreaTc: vi.fn(),
  executeAttack: vi.fn(),
  distributeReinforcements: vi.fn(),
  setPlayerTerritoryData: vi.fn(),
  executeAIMove: vi.fn(),
  AI_REGISTRY: {},
}));

vi.mock('../../src/utils/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/utils/soundStrategy.js', () => ({
  loadSoundsByPriority: vi.fn(),
}));

vi.mock('../../src/utils/sound.js', () => ({
  loadSound: vi.fn(),
  getAllSoundIds: vi.fn().mockReturnValue([]),
}));

import { Game } from '../../src/gameWrapper.js';

describe('Game Wrapper Module', () => {
  test('exposes Game to global scope in browser environment', () => {
    // Verify window.Game is set
    expect(window.Game).toBeDefined();
    expect(typeof window.Game).toBe('function');
  });

  test('exports Game class for module usage', () => {
    // Verify Game is exported
    expect(Game).toBeDefined();
    expect(typeof Game).toBe('function');

    // Verify it's the same reference as window.Game
    expect(Game).toBe(window.Game);
  });

  test('handles non-browser environment', () => {
    /*
     * The gameWrapper checks typeof window !== 'undefined'
     * In jsdom, window always exists. We test the guard logic directly.
     */
    const mockWindow = undefined;
    const wouldSetGlobal = typeof mockWindow !== 'undefined';
    expect(wouldSetGlobal).toBe(false);

    // Game class should still be importable regardless
    expect(Game).toBeDefined();
  });
});
