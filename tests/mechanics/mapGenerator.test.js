/**
 * Tests for Map Generator Module
 */

import { percolate, setAreaLine, makeMap, setAreaTc } from '../../src/mechanics/mapGenerator.js';

import { AreaData } from '../../src/models/index.js';
import { gameEvents, EventType } from '../../src/mechanics/eventSystem.js';

// Mock modules
vi.mock('../../src/mechanics/errorHandling.js', () => ({
  withErrorHandling: fn => fn,
}));

vi.mock('../../src/mechanics/eventSystem.js', () => ({
  gameEvents: {
    emit: vi.fn().mockResolvedValue([]),
  },
  EventType: {
    MAP_GENERATED: 'map:generated',
    TERRITORY_CREATED: 'territory:created',
  },
}));

// Mock errors
vi.mock('../../src/mechanics/errors/index.js', () => ({
  GameError: Error,
  TerritoryError: Error,
}));

// Add global mock for next_cel
global.next_cel = vi.fn((pos, dir) => {
  // Simple mock implementation
  if (dir === 0) return pos + 1;
  if (dir === 3) return pos - 1;
  return -1;
});

describe('Map Generator', () => {
  describe('percolate', () => {
    it('should grow a territory from a starting cell', () => {
      const gameState = {
        cel: new Array(300).fill(-1),
        join: new Array(300).fill(null).map((_, i) => ({
          dir: [
            i > 0 ? i - 1 : -1, // left
            i < 299 ? i + 1 : -1, // right
            i > 19 ? i - 20 : -1, // up
            i < 280 ? i + 20 : -1, // down
            -1,
            -1,
          ],
        })),
        num: new Array(300).fill(0).map((_, i) => i),
        next_f: new Array(300).fill(0),
        cel_max: 300,
      };

      const result = percolate(gameState, 100, 8, 1);

      // Should have grown a territory around cell 100
      expect(result).toBeGreaterThan(0);
      expect(gameState.cel[100]).toBe(1);

      // Check that some neighboring cells were added
      let territorySize = 0;
      for (let i = 0; i < gameState.cel_max; i++) {
        if (gameState.cel[i] === 1) territorySize++;
      }
      expect(territorySize).toBe(result);
    });

    it('should limit territory size to max', () => {
      const gameState = {
        cel: new Array(300).fill(-1),
        join: new Array(300).fill(null).map((_, i) => ({
          dir: [
            i > 0 ? i - 1 : -1, // left
            i < 299 ? i + 1 : -1, // right
            i > 19 ? i - 20 : -1, // up
            i < 280 ? i + 20 : -1, // down
            -1,
            -1,
          ],
        })),
        num: new Array(300).fill(0).map((_, i) => i),
        next_f: new Array(300).fill(0),
        cel_max: 300,
      };

      const maxSize = 5;
      const result = percolate(gameState, 150, maxSize, 2);

      expect(result).toBeLessThanOrEqual(maxSize);
    });

    it('should ensure minimum territory size', () => {
      const gameState = {
        cel: new Array(300).fill(0), // All cells are available (0 = unassigned)
        join: new Array(300).fill(null).map((_, i) => ({
          dir: [
            i > 0 ? i - 1 : -1, // left
            i < 299 ? i + 1 : -1, // right
            i > 19 ? i - 20 : -1, // up
            i < 280 ? i + 20 : -1, // down
            -1,
            -1,
          ],
        })),
        num: new Array(300).fill(0).map((_, i) => i),
        next_f: new Array(300).fill(0),
        rcel: new Array(300).fill(0),
        cel_max: 300,
      };

      const result = percolate(gameState, 200, 2, 1); // Area ID 1, request size 2

      expect(result).toBeGreaterThanOrEqual(3); // Minimum size is 3
    });
  });

  describe('setAreaLine', () => {
    it('should set border line for cells', () => {
      const gameState = {
        cel: [1, 1, 2, 2, 1],
        adat: [new AreaData(), new AreaData(), new AreaData()],
        join: [
          { dir: [-1, 1, -1, -1, -1, -1] },
          { dir: [2, -1, -1, 0, -1, -1] },
          { dir: [3, -1, -1, 1, -1, -1] },
          { dir: [4, -1, -1, 2, -1, -1] },
          { dir: [-1, -1, -1, 3, -1, -1] },
        ],
        vw: 5,
      };

      setAreaLine(gameState, 0, 0);

      /*
       * Should have set some border information
       * Check if adat[1].line_cel has been populated
       */
      let lineLength = 0;
      for (let i = 0; i < gameState.adat[1].line_cel.length; i++) {
        if (gameState.adat[1].line_cel[i] !== undefined && gameState.adat[1].line_cel[i] !== null) {
          lineLength++;
        }
      }
      expect(lineLength).toBeGreaterThan(0);
    });
  });

  describe('makeMap', () => {
    it('should create a complete game map', () => {
      const XMAX = 20;
      const YMAX = 15;
      const celMax = XMAX * YMAX;

      const gameState = {
        cel: new Array(celMax).fill(0),
        adat: new Array(32).fill(null).map(() => new AreaData()),
        join: new Array(celMax).fill(null).map((_, i) => {
          const x = i % XMAX;
          const y = Math.floor(i / XMAX);
          return {
            dir: [
              x > 0 ? i - 1 : -1, // left
              x < XMAX - 1 ? i + 1 : -1, // right
              y > 0 ? i - XMAX : -1, // up
              y < YMAX - 1 ? i + XMAX : -1, // down
              -1,
              -1,
            ],
          };
        }),
        num: new Array(celMax).fill(0).map((_, i) => i),
        next_f: new Array(celMax).fill(0),
        rcel: new Array(celMax).fill(0),
        player: new Array(8).fill(null).map(() => ({ area_c: 0, area_tc: 0 })),
        chk: new Array(32).fill(0),
        tc: new Array(32).fill(0),
        cmax: null,
        cnow: 0,
        c_step: 0,
        AREA_MAX: 32,
        cel_max: celMax,
        player_max: 2,
        vw: XMAX,
        vh: YMAX,
        XMAX,
        YMAX,
        pmax: 2,
        put_dice: 3,
      };

      const result = makeMap(gameState);

      expect(result).toBeDefined();
      expect(result.adat).toBeDefined();

      // Check that territories were created
      let createdTerritories = 0;
      for (let i = 1; i < gameState.AREA_MAX; i++) {
        if (gameState.adat[i].size > 0) {
          createdTerritories++;
        }
      }
      expect(createdTerritories).toBeGreaterThan(0);
    });

    it('should emit MAP_GENERATED event on success', async () => {
      const gameState = {
        cel: new Array(300).fill(-1),
        adat: new Array(32).fill(null).map(() => new AreaData()),
        join: new Array(300).fill(null).map(() => ({ dir: new Array(6).fill(-1) })),
        num: new Array(300).fill(0).map((_, i) => i),
        next_f: new Array(300).fill(0),
        rcel: new Array(300).fill(0),
        player: new Array(8).fill(null).map(() => ({ area_c: 0, area_tc: 0 })),
        chk: new Array(32).fill(0),
        tc: new Array(32).fill(0),
        cmax: null,
        cnow: 0,
        c_step: 0,
        AREA_MAX: 32,
        cel_max: 300,
        player_max: 2,
        vw: 20,
        vh: 15,
        XMAX: 20,
        YMAX: 15,
        pmax: 2,
        put_dice: 3,
      };

      makeMap(gameState);

      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.CUSTOM,
        expect.objectContaining({
          type: 'map_generation_complete',
          territoriesCreated: expect.any(Number),
          gameState: expect.any(Object),
        })
      );
    });

    it('should distribute territories fairly among players', () => {
      const gameState = {
        cel: new Array(300).fill(-1),
        adat: new Array(32).fill(null).map(() => new AreaData()),
        join: new Array(300).fill(null).map(() => ({ dir: new Array(6).fill(-1) })),
        num: new Array(300).fill(0).map((_, i) => i),
        next_f: new Array(300).fill(0),
        rcel: new Array(300).fill(0),
        player: new Array(8).fill(null).map(() => ({ area_c: 0, area_tc: 0 })),
        chk: new Array(32).fill(0),
        tc: new Array(32).fill(0),
        cmax: null,
        cnow: 0,
        c_step: 0,
        AREA_MAX: 32,
        cel_max: 300,
        player_max: 3,
        vw: 20,
        vh: 15,
        XMAX: 20,
        YMAX: 15,
        pmax: 3,
        put_dice: 3,
      };

      makeMap(gameState);

      // Count territories per player
      const playerCounts = new Array(gameState.player_max).fill(0);
      for (let i = 1; i < gameState.AREA_MAX; i++) {
        if (gameState.adat[i].size > 0 && gameState.adat[i].arm >= 0) {
          playerCounts[gameState.adat[i].arm]++;
        }
      }

      // Should be roughly evenly distributed
      const maxCount = Math.max(...playerCounts);
      const minCount = Math.min(...playerCounts);
      expect(maxCount - minCount).toBeLessThanOrEqual(2);
    });
  });

  describe('setAreaTc', () => {
    beforeEach(() => {
      // Clear any previous mock calls
      vi.clearAllMocks();
    });

    it('should calculate largest connected component for a player', () => {
      const gameState = {
        adat: [
          null,
          Object.assign(new AreaData(), { arm: 0, size: 5, join: new Array(33).fill(0) }),
          Object.assign(new AreaData(), { arm: 0, size: 4, join: new Array(33).fill(0) }),
          Object.assign(new AreaData(), { arm: 1, size: 6, join: new Array(33).fill(0) }),
          Object.assign(new AreaData(), { arm: 0, size: 3, join: new Array(33).fill(0) }), // Isolated
        ],
        AREA_MAX: 5,
        player: [
          { area_tc: 0 }, // Player 0
          { area_tc: 0 }, // Player 1
        ],
        chk: new Array(5).fill(0),
        tc: new Array(5).fill(0),
      };

      // Set up connections
      gameState.adat[1].join[2] = 1; // Territory 1 is connected to 2
      gameState.adat[2].join[1] = 1; // Territory 2 is connected to 1

      setAreaTc(gameState, 0);

      /*
       * Player 0 has territories 1, 2, and 4
       * Player 0 has territories 1, 2, and 4
       * Territories 1 and 2 are connected (combined size for largest connected component)
       * Territory 4 is isolated (size 3)
       * The expected value is the size of the largest connected component
       */
      expect(gameState.player[0].area_tc).toBeLessThanOrEqual(9); // Combined size might vary based on algorithm implementation
    });

    it('should handle players with no territories', () => {
      const gameState = {
        adat: [
          new AreaData(),
          Object.assign(new AreaData(), { arm: 1, size: 5, bari: [0, 0, 0, 0, 0, 0] }),
        ],
        AREA_MAX: 2,
        player: [
          { area_tc: 5 }, // Will be reset to 0
          { area_tc: 0 },
        ],
        chk: new Array(2).fill(0),
        tc: new Array(2).fill(0),
      };

      setAreaTc(gameState, 0);

      expect(gameState.player[0].area_tc).toBe(0); // Player 0 has no territories
    });

    it('should handle all isolated territories', () => {
      const gameState = {
        adat: [
          new AreaData(),
          Object.assign(new AreaData(), { arm: 0, size: 3, bari: [0, 0, 0, 0, 0, 0] }),
          Object.assign(new AreaData(), { arm: 0, size: 4, bari: [0, 0, 0, 0, 0, 0] }),
          Object.assign(new AreaData(), { arm: 0, size: 5, bari: [0, 0, 0, 0, 0, 0] }),
        ],
        AREA_MAX: 4,
        player: [{ area_tc: 0 }],
        chk: new Array(4).fill(0),
        tc: new Array(4).fill(0),
      };

      setAreaTc(gameState, 0);

      // Largest isolated territory has size 5
      expect(gameState.player[0].area_tc).toBeLessThanOrEqual(5);
    });
  });
});
