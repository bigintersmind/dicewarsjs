/**
 * Tests for Configuration Management Module
 */
/*
 * Mock the AI module first
 * Now import the module under test
 */
import {
  DEFAULT_CONFIG,
  MAP_SIZE_PRESETS,
  DEFAULT_MAP_SIZE,
  resolveMapSize,
  getConfig,
  updateConfig,
  resetConfig,
  applyConfigToGame,
} from '../../src/utils/config.js';

vi.mock('../../src/ai/index.js', () => {
  const mockDefaultAI = vi.fn();
  const mockDefensiveAI = vi.fn();
  const mockExampleAI = vi.fn();
  const mockAdaptiveAI = vi.fn();

  return {
    AI_STRATEGIES: {
      ai_default: { loader: async () => mockDefaultAI, implementation: mockDefaultAI },
      ai_defensive: { loader: async () => mockDefensiveAI, implementation: mockDefensiveAI },
      ai_example: { loader: async () => mockExampleAI, implementation: mockExampleAI },
      ai_adaptive: { loader: async () => mockAdaptiveAI, implementation: mockAdaptiveAI },
    },
    createAIFunctionMapping: vi.fn(async aiAssignments => {
      const mapping = Array(8).fill(null);

      if (!aiAssignments) return mapping;

      aiAssignments.forEach((type, index) => {
        if (type === 'ai_default') mapping[index] = mockDefaultAI;
        else if (type === 'ai_defensive') mapping[index] = mockDefensiveAI;
        else if (type === 'ai_example') mapping[index] = mockExampleAI;
        else if (type === 'ai_adaptive') mapping[index] = mockAdaptiveAI;
        else if (type !== null) mapping[index] = mockDefaultAI; // Fallback
      });

      return mapping;
    }),
    ai_default: mockDefaultAI,
    ai_defensive: mockDefensiveAI,
    ai_example: mockExampleAI,
    ai_adaptive: mockAdaptiveAI,
    DEFAULT_AI_ASSIGNMENTS: Array(8).fill('ai_default'),
  };
});

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn(key => store[key] || null),
    setItem: vi.fn((key, value) => {
      store[key] = String(value);
    }),
    removeItem: vi.fn(key => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

describe('Configuration Management', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe('DEFAULT_CONFIG', () => {
    test('has the expected default values', () => {
      expect(DEFAULT_CONFIG.playerCount).toBe(7);
      expect(DEFAULT_CONFIG.humanPlayerIndex).toBe(0);
      expect(DEFAULT_CONFIG.averageDicePerArea).toBe(3);
      expect(DEFAULT_CONFIG.aiAssignments).toHaveLength(8);
      expect(DEFAULT_CONFIG.display).toBeDefined();
    });
  });

  describe('map size presets', () => {
    test('exposes small, medium, and large presets with engine dimensions', () => {
      for (const key of ['small', 'medium', 'large']) {
        const preset = MAP_SIZE_PRESETS[key];
        expect(preset).toBeDefined();
        expect(preset.mapWidth).toBeGreaterThan(0);
        expect(preset.mapHeight).toBeGreaterThan(0);
        expect(preset.maxAreas).toBeGreaterThan(0);
      }
    });

    test('medium mirrors DEFAULT_CONFIG so the default reproduces current behaviour', () => {
      expect(MAP_SIZE_PRESETS.medium).toEqual({
        mapWidth: DEFAULT_CONFIG.mapWidth,
        mapHeight: DEFAULT_CONFIG.mapHeight,
        maxAreas: DEFAULT_CONFIG.territoriesCount,
      });
    });

    test('every preset is guaranteed to generate for up to 8 players', () => {
      /*
       * The engine prunes territories smaller than MIN_TERRITORY_SIZE (6 cells)
       * and throws if valid territories < playerCount. Keep cells-per-territory
       * well above 6 and maxAreas >= the 8-player maximum.
       */
      const MAX_PLAYERS = 8;
      for (const key of ['small', 'medium', 'large']) {
        const { mapWidth, mapHeight, maxAreas } = MAP_SIZE_PRESETS[key];
        expect(maxAreas).toBeGreaterThanOrEqual(MAX_PLAYERS);
        const cellsPerArea = (mapWidth * mapHeight) / maxAreas;
        expect(cellsPerArea).toBeGreaterThan(6);
      }
    });

    test('presets are ordered small < medium < large by cell count', () => {
      const cells = key => MAP_SIZE_PRESETS[key].mapWidth * MAP_SIZE_PRESETS[key].mapHeight;
      expect(cells('small')).toBeLessThan(cells('medium'));
      expect(cells('medium')).toBeLessThan(cells('large'));
    });

    test('DEFAULT_MAP_SIZE points at an existing preset', () => {
      expect(DEFAULT_MAP_SIZE).toBe('medium');
      expect(MAP_SIZE_PRESETS[DEFAULT_MAP_SIZE]).toBeDefined();
    });

    describe('resolveMapSize', () => {
      test('resolves each preset key to its dimensions', () => {
        expect(resolveMapSize('small')).toEqual(MAP_SIZE_PRESETS.small);
        expect(resolveMapSize('medium')).toEqual(MAP_SIZE_PRESETS.medium);
        expect(resolveMapSize('large')).toEqual(MAP_SIZE_PRESETS.large);
      });

      test('falls back to the default preset for unknown or invalid keys', () => {
        for (const bad of ['huge', '', undefined, null, 0, 'MEDIUM']) {
          expect(resolveMapSize(bad)).toEqual(MAP_SIZE_PRESETS[DEFAULT_MAP_SIZE]);
        }
      });
    });
  });

  describe('getConfig', () => {
    test('returns a copy of the active config', () => {
      const config = getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(config).not.toBe(DEFAULT_CONFIG); // Should be a different object (copy)
    });
  });

  describe('updateConfig', () => {
    test('updates existing config values', () => {
      const newConfig = {
        playerCount: 4,
        humanPlayerIndex: 2,
      };

      updateConfig(newConfig);
      const updatedConfig = getConfig();

      expect(updatedConfig.playerCount).toBe(4);
      expect(updatedConfig.humanPlayerIndex).toBe(2);
      expect(updatedConfig.averageDicePerArea).toBe(DEFAULT_CONFIG.averageDicePerArea);
    });

    test('updates nested display object', () => {
      const newConfig = {
        display: {
          viewWidth: 1024,
          viewHeight: 768,
        },
      };

      updateConfig(newConfig);
      const updatedConfig = getConfig();

      expect(updatedConfig.display.viewWidth).toBe(1024);
      expect(updatedConfig.display.viewHeight).toBe(768);
      expect(updatedConfig.display.cellWidth).toBe(DEFAULT_CONFIG.display.cellWidth);
    });

    test('saves to localStorage if available', () => {
      const newConfig = { playerCount: 4 };
      updateConfig(newConfig);

      expect(localStorage.setItem).toHaveBeenCalled();
      expect(localStorage.setItem.mock.calls[0][0]).toBe('dicewarsConfig');
      expect(JSON.parse(localStorage.setItem.mock.calls[0][1])).toMatchObject(newConfig);
    });
  });

  describe('resetConfig', () => {
    test('resets config to default values', () => {
      updateConfig({ playerCount: 4 });
      expect(getConfig().playerCount).toBe(4);

      resetConfig();
      expect(getConfig()).toEqual(DEFAULT_CONFIG);
    });

    test('removes config from localStorage', () => {
      updateConfig({ playerCount: 4 });
      resetConfig();

      expect(localStorage.removeItem).toHaveBeenCalledWith('dicewarsConfig');
    });
  });

  describe('applyConfigToGame', () => {
    test('applies config values to game object', async () => {
      // Mock AI functions for testing
      const mockDefaultAI = vi.fn();
      const mockDefensiveAI = vi.fn();
      const mockExampleAI = vi.fn();
      const mockAdaptiveAI = vi.fn();

      // Our mocks are already set up at the top of the file

      const game = {
        pmax: 0,
        user: 0,
        put_dice: 0,
        XMAX: 0,
        YMAX: 0,
        AREA_MAX: 0,
        ai: [null, null, null, null, null, null, null, null],
        aiRegistry: {
          ai_default: mockDefaultAI,
          ai_defensive: mockDefensiveAI,
          ai_example: mockExampleAI,
          ai_adaptive: mockAdaptiveAI,
        },
        configureAI: vi.fn(function (aiAssignments) {
          // Simple implementation to simulate the configureAI function
          for (let i = 0; i < aiAssignments.length && i < this.ai.length; i++) {
            if (aiAssignments[i] === 'ai_default') this.ai[i] = this.aiRegistry.ai_default;
            else if (aiAssignments[i] === 'ai_defensive') this.ai[i] = this.aiRegistry.ai_defensive;
            else if (aiAssignments[i] === 'ai_example') this.ai[i] = this.aiRegistry.ai_example;
            else if (aiAssignments[i] === 'ai_adaptive') this.ai[i] = this.aiRegistry.ai_adaptive;
            else if (aiAssignments[i] !== null) this.ai[i] = this.aiRegistry.ai_default;
          }

          return this;
        }),
      };

      const config = {
        playerCount: 5,
        humanPlayerIndex: 2,
        averageDicePerArea: 4,
        mapWidth: 30,
        mapHeight: 34,
        territoriesCount: 36,
        aiAssignments: [
          null,
          'ai_adaptive',
          'ai_defensive',
          'ai_example',
          'ai_default',
          null,
          null,
          null,
        ],
      };

      await applyConfigToGame(game, config);

      expect(game.pmax).toBe(5);
      expect(game.user).toBe(2);
      expect(game.put_dice).toBe(4);
      expect(game.XMAX).toBe(30);
      expect(game.YMAX).toBe(34);
      expect(game.AREA_MAX).toBe(36);

      /*
       * For the purposes of this test, we only check if configureAI was called
       * since the actual AI assignment happens in that function
       */
      expect(game.configureAI).toHaveBeenCalled();
    });

    test('handles unknown AI types gracefully', async () => {
      // Create mock function
      const mockDefaultAI = vi.fn();

      const game = {
        ai: [null, null],
        aiRegistry: {
          ai_default: mockDefaultAI,
        },
        configureAI: vi.fn(function (aiAssignments) {
          // Simple implementation to simulate the configureAI function
          for (let i = 0; i < aiAssignments.length && i < this.ai.length; i++) {
            if (aiAssignments[i] === null) {
              this.ai[i] = null;
            } else {
              // Default to ai_default for unknown types
              this.ai[i] = this.aiRegistry.ai_default;
            }
          }
          return this;
        }),
      };

      const config = {
        aiAssignments: [null, 'ai_unknown'],
      };

      await applyConfigToGame(game, config);

      expect(game.ai[0]).toBeNull();
      expect(game.ai[1]).toBe(game.aiRegistry.ai_default);
    });
  });
});
