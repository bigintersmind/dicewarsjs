/**
 * Test file for game-loader.js
 *
 * This tests the placeholder AI functions and registry created by game-loader.js
 */

describe('Game Loader', () => {
  const originalConsole = { ...console };

  beforeEach(async () => {
    // Mock console
    global.console = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    window.ES6_LOADING_STARTED = false;

    // Clean up any previously loaded globals
    delete window.ai_default;
    delete window.ai_defensive;
    delete window.ai_example;
    delete window.ai_adaptive;
    delete window.AI_REGISTRY;
    delete window.getAIFunctionByName;
    delete window.GAME_CONFIG;

    // Reset and re-import to get fresh side effects
    vi.resetModules();
    await import('../../src/game-loader.js');
  });

  afterEach(() => {
    global.console = originalConsole;
  });

  test('should set up placeholder AI functions', () => {
    expect(typeof window.ai_default).toBe('function');
    expect(typeof window.ai_defensive).toBe('function');
    expect(typeof window.ai_example).toBe('function');
    expect(typeof window.ai_adaptive).toBe('function');

    expect(window.AI_REGISTRY).toBeDefined();
    expect(window.AI_REGISTRY.ai_default).toBe(window.ai_default);
    expect(window.AI_REGISTRY.ai_defensive).toBe(window.ai_defensive);
    expect(window.AI_REGISTRY.ai_example).toBe(window.ai_example);
    expect(window.AI_REGISTRY.ai_adaptive).toBe(window.ai_adaptive);
  });

  test('ai_default should make random valid moves', () => {
    const mockGame = {
      adat: [
        { arm: 1, dice: 3, join: [0, 1, 1, 0] },
        { arm: 2, dice: 2, join: [1, 0, 0, 1] },
        { arm: 1, dice: 1, join: [1, 0, 0, 0] },
        { arm: 2, dice: 4, join: [0, 1, 0, 0] },
      ],
      get_pn: vi.fn().mockReturnValue(1),
      area_from: null,
      area_to: null,
    };

    const result = window.ai_default(mockGame);

    expect(console.warn).toHaveBeenCalledWith(
      'Using placeholder ai_default - ES6 module not loaded'
    );

    expect(result === 0 || (mockGame.area_from === 0 && mockGame.area_to === 1)).toBe(true);
  });

  test('ai_default should end turn when no valid moves exist', () => {
    const mockGame = {
      adat: [
        { arm: 1, dice: 1, join: [0, 1, 0, 0] },
        { arm: 2, dice: 5, join: [1, 0, 0, 0] },
        { arm: 3, dice: 4, join: [0, 0, 0, 0] },
      ],
      get_pn: vi.fn().mockReturnValue(1),
      area_from: null,
      area_to: null,
    };

    const result = window.ai_default(mockGame);
    expect(result).toBe(0);
  });

  test('other AI placeholders should call ai_default', () => {
    const originalAiDefault = window.ai_default;
    window.ai_default = vi.fn().mockReturnValue(42);

    const mockGame = { get_pn: vi.fn().mockReturnValue(1) };

    const defResult = window.ai_defensive(mockGame);
    const exampleResult = window.ai_example(mockGame);
    const adaptiveResult = window.ai_adaptive(mockGame);

    expect(window.ai_default).toHaveBeenCalledTimes(3);
    expect(window.ai_default).toHaveBeenCalledWith(mockGame);

    expect(defResult).toBe(42);
    expect(exampleResult).toBe(42);
    expect(adaptiveResult).toBe(42);

    window.ai_default = originalAiDefault;
  });

  test('getAIFunctionByName should return the correct AI function', () => {
    expect(window.getAIFunctionByName('ai_default')).toBe(window.ai_default);
    expect(window.getAIFunctionByName('ai_defensive')).toBe(window.ai_defensive);
    expect(window.getAIFunctionByName('ai_example')).toBe(window.ai_example);
    expect(window.getAIFunctionByName('ai_adaptive')).toBe(window.ai_adaptive);

    expect(window.getAIFunctionByName('nonexistent_ai')).toBe(window.ai_default);
    expect(window.getAIFunctionByName(null)).toBe(window.ai_default);
    expect(window.getAIFunctionByName(undefined)).toBe(window.ai_default);
    expect(window.getAIFunctionByName(123)).toBe(window.ai_default);

    expect(console.warn).toHaveBeenCalledWith('AI type nonexistent_ai not found, using default AI');
  });

  test('should not log warnings when ES6_LOADING_STARTED is true', async () => {
    window.ES6_LOADING_STARTED = true;

    // Clean and re-import with the flag set
    delete window.ai_default;
    delete window.ai_defensive;
    delete window.ai_example;
    delete window.ai_adaptive;
    vi.resetModules();
    await import('../../src/game-loader.js');

    const mockGame = {
      adat: [],
      get_pn: vi.fn().mockReturnValue(1),
    };

    // Reset warn mock to only track post-load calls
    console.warn.mockClear();

    window.ai_default(mockGame);
    window.ai_defensive(mockGame);
    window.ai_example(mockGame);
    window.ai_adaptive(mockGame);

    expect(console.warn).not.toHaveBeenCalled();
  });

  test('should set up GAME_CONFIG placeholder if not already defined', () => {
    expect(window.GAME_CONFIG).toBeDefined();
    expect(typeof window.GAME_CONFIG).toBe('object');
  });

  test('should not overwrite existing GAME_CONFIG', async () => {
    // Set up existing GAME_CONFIG and re-import
    window.GAME_CONFIG = { existingProp: 'value' };
    vi.resetModules();
    await import('../../src/game-loader.js');

    expect(window.GAME_CONFIG.existingProp).toBe('value');
  });
});
