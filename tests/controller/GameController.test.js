// @vitest-environment jsdom
/**
 * GameController tests
 *
 * Tests the game loop orchestration: start/accept/reject game, human click
 * handling, AI turn execution, and error recovery.
 */

import { createGameController, MAX_GAME_TURNS } from '../../src/controller/GameController.js';
import { createGameStore } from '../../src/store/GameStore.js';

/*
 * ---------------------------------------------------------------------------
 * Mocks
 * ---------------------------------------------------------------------------
 */

// Minimal game state factory
function makeGameState(overrides = {}) {
  return {
    phase: 'playing',
    grid: { width: 28, height: 32, cellCount: 896 },
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    history: [],
    areas: {
      0: null, // area 0 is unused
      1: { owner: 0, dice: 3, neighborAreaIds: [2, 3] },
      2: { owner: 1, dice: 2, neighborAreaIds: [1, 3] },
      3: { owner: 0, dice: 1, neighborAreaIds: [1, 2] },
    },
    players: [
      { id: 0, alive: true, territoryCount: 2 },
      { id: 1, alive: true, territoryCount: 1 },
    ],
    ...overrides,
  };
}

// Mock engine
vi.mock('../../src/engine/index.js', () => ({
  createGame: vi.fn(() => makeGameState()),
  applyAction: vi.fn((state, action) => {
    if (action.type === 'END_TURN') {
      return {
        ...state,
        currentPlayerIndex: (state.currentPlayerIndex + 1) % state.turnOrder.length,
        history: [...state.history, { type: 'END_TURN' }],
      };
    }
    if (action.type === 'ATTACK') {
      return {
        ...state,
        history: [
          ...state.history,
          {
            type: 'ATTACK',
            from: action.from,
            to: action.to,
            result: {
              success: true,
              attackerRoll: { values: [6], total: 6 },
              defenderRoll: { values: [1], total: 1 },
            },
          },
        ],
      };
    }
    return state;
  }),
  getValidMoves: vi.fn(() => []),
  ACTION_TYPES: { ATTACK: 'ATTACK', END_TURN: 'END_TURN' },
  GAME_PHASES: { PLAYING: 'playing', GAME_OVER: 'gameOver' },
}));

vi.mock('../../src/engine/AIAdapter.js', () => ({
  runAI: vi.fn(() => null), // AI immediately ends turn
}));

vi.mock('../../src/ai/aiConfig.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAIImplementation: vi.fn(async id => {
      if (id === 'FAIL_ALL') throw new Error('Module load failed');
      return vi.fn(() => 0); // AI function that ends turn
    }),
  };
});

vi.mock('../../src/arena/communityBots.js', () => ({
  getCommunityBotList: vi.fn(() => []),
  loadCommunityBot: vi.fn(() => vi.fn(() => null)), // compiled modern bot stub
}));

vi.mock('../../src/arena/modernBotAdapter.js', () => ({
  // Mirror the real adapter's shape: tag __modernBot and set the function name.
  adaptModernBot: vi.fn((fn, name) => {
    const wrapped = () => fn();
    wrapped.__modernBot = true;
    Object.defineProperty(wrapped, 'name', { value: name });
    return wrapped;
  }),
}));

vi.mock('../../src/utils/config.js', () => ({
  // Mirror the real preset table so assertions on dimensions are meaningful.
  resolveMapSize: vi.fn(size => {
    const presets = {
      small: { mapWidth: 20, mapHeight: 24, maxAreas: 20 },
      medium: { mapWidth: 28, mapHeight: 32, maxAreas: 32 },
      large: { mapWidth: 36, mapHeight: 40, maxAreas: 48 },
    };
    return presets[size] ?? presets.medium;
  }),
}));

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

function createMockRenderer() {
  return {
    initialized: true,
    drawMap: vi.fn(),
    update: vi.fn(),
    hitTest: vi.fn(() => 0),
    screenToMap: vi.fn(() => ({ x: 0, y: 0 })),
    hexGrid: {
      clearHighlights: vi.fn(),
      setHighlight: vi.fn(),
      _getPlayerColor: vi.fn(() => 0xffffff),
    },
    getPlayerColor: vi.fn(() => 0xffffff),
    battle: {
      play: vi.fn(async () => {}),
      destroy: vi.fn(),
    },
    dice: { destroy: vi.fn() },
    destroy: vi.fn(),
    playParticleEffect: vi.fn(),
    screenShake: vi.fn(() => Promise.resolve()),
    animateReinforcements: vi.fn(() => Promise.resolve()),
    playCelebration: vi.fn(() => Promise.resolve()),
  };
}

/** Flush all pending microtasks (Promise callbacks). */
function flushPromises() {
  return vi.advanceTimersByTimeAsync(0);
}

function createMockSoundManager() {
  return {
    play: vi.fn(),
    loadAll: vi.fn(async () => {}),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe('GameController', () => {
  let store, renderer, soundManager, controller;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    store = createGameStore();
    renderer = createMockRenderer();
    soundManager = createMockSoundManager();
    controller = createGameController(store, renderer, soundManager);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /*
   * -----------------------------------------------------------------------
   * startNewGame
   * -----------------------------------------------------------------------
   */

  describe('startNewGame', () => {
    it('creates a game and transitions to mapPreview', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });

      const state = store.getState();
      expect(state.screen).toBe('mapPreview');
      expect(state.gameState).toBeTruthy();
      expect(state.animationPhase).toBe('idle');
    });

    it('calls renderer.drawMap with game state', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(renderer.drawMap).toHaveBeenCalledTimes(1);
      expect(renderer.drawMap).toHaveBeenCalledWith(expect.objectContaining({ phase: 'playing' }));
    });

    it('preloads sounds', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(soundManager.loadAll).toHaveBeenCalledTimes(1);
    });

    it('threads custom aiAssignments into store config, keeping slot 0 human', async () => {
      const custom = [null, 'ai_strategist', 'ai_lookahead'];
      await controller.startNewGame({ playerCount: 3, spectator: false, aiAssignments: custom });

      expect(store.getState().config.aiAssignments).toEqual(custom);
      expect(store.getState().config.aiAssignments[0]).toBeNull();
    });

    it('loads the AI implementations named in aiAssignments', async () => {
      const { getAIImplementation } = await import('../../src/ai/aiConfig.js');

      await controller.startNewGame({
        playerCount: 3,
        spectator: false,
        aiAssignments: [null, 'ai_strategist', 'ai_lookahead'],
      });

      expect(getAIImplementation).toHaveBeenCalledWith('ai_strategist');
      expect(getAIImplementation).toHaveBeenCalledWith('ai_lookahead');
    });

    it('falls back to the store lineup when aiAssignments is omitted', async () => {
      const before = store.getState().config.aiAssignments;
      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(store.getState().config.aiAssignments).toEqual(before);
    });

    it('resolves a community: assignment through the loader + modern adapter', async () => {
      const { loadCommunityBot } = await import('../../src/arena/communityBots.js');
      const { adaptModernBot } = await import('../../src/arena/modernBotAdapter.js');

      await controller.startNewGame({
        playerCount: 3,
        spectator: false,
        aiAssignments: [null, 'community:bigintersmind/connector', 'ai_default'],
      });

      // The `community:` prefix is stripped before lookup, then reverse-adapted.
      expect(loadCommunityBot).toHaveBeenCalledWith('bigintersmind/connector');
      expect(adaptModernBot).toHaveBeenCalledWith(
        expect.any(Function),
        'community:bigintersmind/connector'
      );
    });

    it('falls back to ai_default and surfaces a notice when a community bot fails to load', async () => {
      const { loadCommunityBot } = await import('../../src/arena/communityBots.js');
      const { getAIImplementation } = await import('../../src/ai/aiConfig.js');
      loadCommunityBot.mockImplementationOnce(() => {
        throw new Error('compile failed');
      });

      await controller.startNewGame({
        playerCount: 3,
        spectator: false,
        aiAssignments: [null, 'community:broken/bot', 'ai_default'],
      });

      // The game still starts (fallback succeeded), not a crash back to title.
      expect(store.getState().screen).toBe('mapPreview');
      expect(getAIImplementation).toHaveBeenCalledWith('ai_default');

      // The player's discarded choice is surfaced, not silently swapped.
      const warnings = store.getState().aiLoadWarnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('broken/bot');
    });

    it('resets to title screen on createGame failure', async () => {
      const { createGame } = await import('../../src/engine/index.js');
      createGame.mockImplementationOnce(() => {
        throw new Error('Map generation failed');
      });

      await controller.startNewGame({ playerCount: 2, spectator: false });

      const state = store.getState();
      expect(state.screen).toBe('title');
      expect(state.gameState).toBeNull();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * acceptMap / rejectMap
   * -----------------------------------------------------------------------
   */

  describe('acceptMap', () => {
    it('transitions to playing screen and starts turn', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      const state = store.getState();
      expect(state.screen).toBe('playing');
    });

    it('sets awaitingInput for human player', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      expect(store.getState().awaitingInput).toBe('selectFrom');
    });
  });

  describe('rejectMap', () => {
    it('generates a new map and calls drawMap', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      renderer.drawMap.mockClear();

      await controller.rejectMap();

      expect(renderer.drawMap).toHaveBeenCalledTimes(1);
      expect(store.getState().screen).toBe('mapPreview');
    });

    it('resets to title on createGame failure', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });

      const { createGame } = await import('../../src/engine/index.js');
      createGame.mockImplementationOnce(() => {
        throw new Error('Map generation failed');
      });

      await controller.rejectMap();
      expect(store.getState().screen).toBe('title');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * map size selection
   * -----------------------------------------------------------------------
   */

  describe('map size selection', () => {
    it('passes the resolved default (medium) dimensions to createGame', async () => {
      const { createGame } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(createGame).toHaveBeenCalledWith(
        expect.objectContaining({ mapWidth: 28, mapHeight: 32, maxAreas: 32 })
      );
    });

    it('resolves the chosen preset to engine dimensions (large)', async () => {
      const { createGame } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false, mapSize: 'large' });

      expect(createGame).toHaveBeenCalledWith(
        expect.objectContaining({ playerCount: 2, mapWidth: 36, mapHeight: 40, maxAreas: 48 })
      );
    });

    it('persists the chosen map size into store config', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false, mapSize: 'small' });

      expect(store.getState().config.mapSize).toBe('small');
    });

    it('rejectMap regenerates at the size the player chose', async () => {
      const { createGame } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false, mapSize: 'small' });
      createGame.mockClear();

      await controller.rejectMap();

      expect(createGame).toHaveBeenCalledWith(
        expect.objectContaining({ mapWidth: 20, mapHeight: 24, maxAreas: 20 })
      );
    });

    it('falls back to the store map size when the caller omits it', async () => {
      const { createGame } = await import('../../src/engine/index.js');
      store.setState({ config: { ...store.getState().config, mapSize: 'large' } });

      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(createGame).toHaveBeenCalledWith(
        expect.objectContaining({ mapWidth: 36, mapHeight: 40, maxAreas: 48 })
      );
    });

    it('threads map size in spectator (AI vs AI) mode', async () => {
      const { createGame } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: true, mapSize: 'large' });

      expect(createGame).toHaveBeenCalledWith(
        expect.objectContaining({ mapWidth: 36, mapHeight: 40, maxAreas: 48 })
      );
    });
  });

  /*
   * -----------------------------------------------------------------------
   * difficulty selection
   * -----------------------------------------------------------------------
   */

  describe('difficulty selection', () => {
    it('persists the chosen difficulty in store config (#167)', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false, difficulty: 'hard' });
      expect(store.getState().config.difficulty).toBe('hard');
    });

    it('keeps the stored difficulty when the caller omits it', async () => {
      store.setState({ config: { ...store.getState().config, difficulty: 'easy' } });
      await controller.startNewGame({ playerCount: 2, spectator: false });
      expect(store.getState().config.difficulty).toBe('easy');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * goToTitle
   * -----------------------------------------------------------------------
   */

  describe('goToTitle', () => {
    it('resets to title screen', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.goToTitle();

      const state = store.getState();
      expect(state.screen).toBe('title');
      expect(state.gameState).toBeNull();
      expect(state.awaitingInput).toBeNull();
      expect(state.animationPhase).toBe('idle');
      expect(state.currentReplay).toBeNull();
    });
  });

  describe('goToReplay', () => {
    it('transitions to replay screen with replay data', () => {
      const fakeReplay = { version: 1, config: {}, actions: [], metadata: {} };
      controller.goToReplay(fakeReplay);
      const state = store.getState();
      expect(state.screen).toBe('replay');
      expect(state.currentReplay).toBe(fakeReplay);
    });

    it('clears currentReplay when returning to title', () => {
      const fakeReplay = { version: 1, config: {}, actions: [], metadata: {} };
      controller.goToReplay(fakeReplay);
      controller.goToTitle();
      expect(store.getState().currentReplay).toBeNull();
      expect(store.getState().screen).toBe('title');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * updateReplayBoard
   * -----------------------------------------------------------------------
   */

  describe('updateReplayBoard', () => {
    const grid = { width: 28, height: 32 };
    const stateA = { grid, areas: [null, { owner: 0 }] };
    const stateB = { grid, areas: [null, { owner: 1 }] };

    it('draws the full map on the first call', () => {
      controller.updateReplayBoard(stateA);

      expect(renderer.drawMap).toHaveBeenCalledTimes(1);
      expect(renderer.drawMap).toHaveBeenCalledWith(stateA);
      expect(renderer.update).not.toHaveBeenCalled();
    });

    it('uses incremental update for consecutive steps of the same game', () => {
      controller.updateReplayBoard(stateA);
      controller.updateReplayBoard(stateB);

      expect(renderer.drawMap).toHaveBeenCalledTimes(1);
      expect(renderer.update).toHaveBeenCalledTimes(1);
      expect(renderer.update).toHaveBeenCalledWith(stateA, stateB);
    });

    it('redraws the full map when the grid changes (new replay)', () => {
      const otherGameState = { grid: { width: 28, height: 32 }, areas: [null, { owner: 0 }] };

      controller.updateReplayBoard(stateA);
      controller.updateReplayBoard(otherGameState);

      expect(renderer.drawMap).toHaveBeenCalledTimes(2);
      expect(renderer.update).not.toHaveBeenCalled();
    });

    it('redraws the full map after leaving the replay viewer', () => {
      controller.updateReplayBoard(stateA);
      controller.goBackFromReplay();
      controller.updateReplayBoard(stateB);

      expect(renderer.drawMap).toHaveBeenCalledTimes(2);
      expect(renderer.update).not.toHaveBeenCalled();
    });

    it('diffs each step against the previous one, not the first frame', () => {
      const stateC = { grid, areas: [null, { owner: 2 }] };
      controller.updateReplayBoard(stateA);
      controller.updateReplayBoard(stateB);
      controller.updateReplayBoard(stateC);

      // Each step must advance the cached "prev": B diffs vs A, C diffs vs B.
      expect(renderer.update).toHaveBeenNthCalledWith(1, stateA, stateB);
      expect(renderer.update).toHaveBeenNthCalledWith(2, stateB, stateC);
    });

    it('re-throws a render failure and recovers with a full redraw on the next step', () => {
      renderer.update.mockImplementationOnce(() => {
        throw new Error('pixi blew up');
      });
      controller.updateReplayBoard(stateA); // full draw, caches stateA
      expect(() => controller.updateReplayBoard(stateB)).toThrow(
        'Failed to render the game board for this replay step.'
      );

      // The failed update() cleared the cached state, so the next step must
      // take the full-drawMap branch rather than diffing against a stale frame.
      const stateC = { grid, areas: [null, { owner: 2 }] };
      controller.updateReplayBoard(stateC);
      expect(renderer.drawMap).toHaveBeenCalledTimes(2);
      expect(renderer.drawMap).toHaveBeenLastCalledWith(stateC);
    });
  });

  /*
   * -----------------------------------------------------------------------
   * handleTerritoryClick
   * -----------------------------------------------------------------------
   */

  describe('handleTerritoryClick', () => {
    beforeEach(async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      // Now: screen='playing', awaitingInput='selectFrom', humanPlayerIndex=0
    });

    it('ignores areaId 0', () => {
      controller.handleTerritoryClick(0);
      expect(store.getState().selectedFrom).toBeNull();
    });

    it('ignores clicks when not on playing screen', () => {
      store.setState({ screen: 'title' });
      controller.handleTerritoryClick(1);
      expect(store.getState().selectedFrom).toBeNull();
    });

    it('ignores clicks when not human turn', () => {
      const gs = store.getState().gameState;
      store.setState({ gameState: { ...gs, currentPlayerIndex: 1 } });
      controller.handleTerritoryClick(1);
      expect(store.getState().selectedFrom).toBeNull();
    });

    it('selects a valid attack source territory', () => {
      controller.handleTerritoryClick(1); // area 1: owned by player 0, 3 dice

      expect(store.getState().selectedFrom).toBe(1);
      expect(store.getState().awaitingInput).toBe('selectTo');
      expect(renderer.hexGrid.setHighlight).toHaveBeenCalledWith('from', 1);
    });

    it('rejects selecting territory with only 1 die', () => {
      controller.handleTerritoryClick(3); // area 3: owned by player 0, 1 die

      expect(store.getState().selectedFrom).toBeNull();
      expect(store.getState().awaitingInput).toBe('selectFrom');
    });

    it('rejects selecting enemy territory as source', () => {
      controller.handleTerritoryClick(2); // area 2: owned by player 1

      expect(store.getState().selectedFrom).toBeNull();
    });

    it('executes attack on valid target', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      controller.handleTerritoryClick(1); // select from
      controller.handleTerritoryClick(2); // select to (adjacent enemy)

      // Let animation complete
      await vi.runAllTimersAsync();

      expect(applyAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'ATTACK', from: 1, to: 2 })
      );
    });

    it('allows reselecting own territory during selectTo phase', () => {
      // Modify area 3 to have more dice for re-selection test
      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: { ...gs.areas, 3: { ...gs.areas[3], dice: 2 } },
        },
      });

      controller.handleTerritoryClick(1); // select from area 1
      expect(store.getState().selectedFrom).toBe(1);

      controller.handleTerritoryClick(3); // re-select own area 3 (now 2 dice)
      expect(store.getState().selectedFrom).toBe(3);
      expect(store.getState().awaitingInput).toBe('selectTo');
    });

    it('rejects non-adjacent target', () => {
      // area 1's neighbors are [2, 3]; we need an area not in that list
      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: {
            ...gs.areas,
            4: { owner: 1, dice: 2, neighborAreaIds: [5] },
          },
        },
      });

      controller.handleTerritoryClick(1); // select from
      controller.handleTerritoryClick(4); // non-adjacent target

      // Should still be in selectTo phase, no attack executed
      expect(store.getState().awaitingInput).toBe('selectTo');
    });

    it('rejects clicks during animation (C1 fix)', () => {
      store.setState({ animationPhase: 'battle' });

      controller.handleTerritoryClick(1);
      expect(store.getState().selectedFrom).toBeNull();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * executeAttack race condition (C1)
   * -----------------------------------------------------------------------
   */

  describe('executeAttack race condition (C1)', () => {
    it('sets awaitingInput to null immediately on attack', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      controller.handleTerritoryClick(1); // select from
      expect(store.getState().awaitingInput).toBe('selectTo');

      controller.handleTerritoryClick(2); // trigger attack

      // awaitingInput should be null immediately (before animation completes)
      expect(store.getState().awaitingInput).toBeNull();

      // Let animation and async effects finish
      await vi.runAllTimersAsync();
      await flushPromises();

      // After animation, it should be back to selectFrom
      expect(store.getState().awaitingInput).toBe('selectFrom');
    });

    it('blocks second click during animation', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      controller.handleTerritoryClick(1); // select from
      controller.handleTerritoryClick(2); // trigger attack

      applyAction.mockClear();

      // Second click while animation is playing — should be blocked
      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      expect(applyAction).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'ATTACK' })
      );

      await vi.runAllTimersAsync();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * endHumanTurn
   * -----------------------------------------------------------------------
   */

  describe('endHumanTurn', () => {
    it('ends turn when awaitingInput is set', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      expect(store.getState().awaitingInput).toBe('selectFrom');

      controller.endHumanTurn();

      expect(applyAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'END_TURN' })
      );
      expect(store.getState().awaitingInput).toBeNull();
    });

    it('no-ops when awaitingInput is null', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      // Don't call acceptMap, so awaitingInput stays null
      applyAction.mockClear();

      controller.endHumanTurn();

      expect(applyAction).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'END_TURN' })
      );
    });
  });

  /*
   * -----------------------------------------------------------------------
   * loadAIFunctions fallback (C3)
   * -----------------------------------------------------------------------
   */

  describe('AI load fallback (C3)', () => {
    it('falls back to ai_default when primary AI fails', async () => {
      const { getAIImplementation } = await import('../../src/ai/aiConfig.js');

      // First call fails, second (fallback) succeeds
      getAIImplementation
        .mockRejectedValueOnce(new Error('Module load failed'))
        .mockResolvedValueOnce(vi.fn(() => 0)); // fallback AI

      // Should not throw — falls back gracefully
      await controller.startNewGame({ playerCount: 2, spectator: false });
      expect(store.getState().screen).toBe('mapPreview');
    });

    it('resets to title when both primary and fallback AI fail', async () => {
      const { getAIImplementation } = await import('../../src/ai/aiConfig.js');

      // Both calls fail
      getAIImplementation
        .mockResolvedValueOnce(vi.fn(() => 0)) // player 0 (human, null — won't call)
        .mockRejectedValueOnce(new Error('Primary failed'))
        .mockRejectedValueOnce(new Error('Fallback failed'));

      // With spectator mode to force all players to load AI
      await controller.startNewGame({ playerCount: 2, spectator: true });
      expect(store.getState().screen).toBe('title');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * executeAttack error handling
   * -----------------------------------------------------------------------
   */

  describe('executeAttack error handling', () => {
    it('resets selection on applyAction failure', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      applyAction.mockImplementationOnce(() => {
        throw new Error('Invalid attack');
      });

      controller.handleTerritoryClick(1); // select from
      controller.handleTerritoryClick(2); // select to — will fail

      await vi.runAllTimersAsync();

      expect(store.getState().selectedFrom).toBeNull();
      expect(store.getState().awaitingInput).toBe('selectFrom');
      expect(renderer.hexGrid.clearHighlights).toHaveBeenCalled();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * AI turn: invalidCount reset (C1 fix)
   * -----------------------------------------------------------------------
   */

  describe('AI turn invalidCount reset', () => {
    it('resets invalid count after a valid move so AI is not force-stopped', async () => {
      const { applyAction, getValidMoves } = await import('../../src/engine/index.js');
      const { runAI } = await import('../../src/engine/AIAdapter.js');

      /*
       * Configure AI to return: invalid, invalid, valid, invalid, invalid, valid, null.
       * Without the reset fix, the AI would stop after 3 total invalids (moves 1,2,4).
       * With the fix, count resets after each valid move.
       */
      let moveCount = 0;
      runAI.mockImplementation(() => {
        moveCount++;
        if (moveCount <= 2) return { from: 99, to: 99 }; // invalid
        if (moveCount === 3) return { from: 1, to: 2 }; // valid — resets counter
        if (moveCount <= 5) return { from: 99, to: 99 }; // invalid again
        if (moveCount === 6) return { from: 1, to: 2 }; // valid
        return null; // end turn
      });

      getValidMoves.mockImplementation(() => [{ from: 1, to: 2 }]);

      /*
       * applyAction: ATTACK succeeds, first END_TURN advances player,
       * second END_TURN (AI's) triggers game over to stop the loop.
       */
      let endTurnCount = 0;
      applyAction.mockImplementation((state, action) => {
        if (action.type === 'ATTACK') {
          return {
            ...state,
            history: [
              ...state.history,
              {
                type: 'ATTACK',
                from: action.from,
                to: action.to,
                result: {
                  success: true,
                  attackerRoll: { values: [6], total: 6 },
                  defenderRoll: { values: [1], total: 1 },
                },
              },
            ],
          };
        }
        endTurnCount++;
        if (endTurnCount === 1) {
          // First END_TURN (human) → advance to player 1 (AI)
          return {
            ...state,
            currentPlayerIndex: 1,
            history: [...state.history, { type: 'END_TURN' }],
          };
        }
        // Subsequent END_TURN → game over to stop the loop
        return { ...state, phase: 'gameOver', winner: 0 };
      });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      /*
       * End human turn, which triggers AI turn for player 1.
       * endTurn is async; the chain is:
       * endTurn → setTimeout(startTurn) → runAITurn → endTurn → gameOver
       * Flush multiple rounds of timers + microtasks.
       */
      controller.endHumanTurn();
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      /*
       * With the fix, AI should have made 2 valid ATTACK moves (moves 3 and 6).
       * Without the fix, it would stop after move 4 (3 total invalids) and make only 1 attack.
       */
      const attackCalls = applyAction.mock.calls.filter(([, action]) => action.type === 'ATTACK');
      expect(attackCalls.length).toBe(2);
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Game over transitions
   * -----------------------------------------------------------------------
   */

  describe('game over transitions', () => {
    it('transitions to gameOver screen when human attack wins the game', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      // Make applyAction return game-over state on ATTACK
      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'ATTACK') {
          return {
            ...state,
            phase: 'gameOver',
            winner: 0,
            history: [
              ...state.history,
              {
                type: 'ATTACK',
                from: action.from,
                to: action.to,
                result: {
                  success: true,
                  attackerRoll: { values: [6], total: 6 },
                  defenderRoll: { values: [1], total: 1 },
                },
              },
            ],
          };
        }
        return state;
      });

      controller.handleTerritoryClick(1); // select from
      controller.handleTerritoryClick(2); // attack — triggers game over

      /*
       * executeAttack is async (fire-and-forget from handleTerritoryClick).
       * Flush multiple rounds: timers and microtasks interleave.
       */
      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(store.getState().screen).toBe('gameOver');
      expect(soundManager.play).toHaveBeenCalledWith('over');
    });

    it('transitions to gameOver screen when endTurn results in game over', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      // Make END_TURN return game-over
      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'END_TURN') {
          return { ...state, phase: 'gameOver', winner: 1 };
        }
        return state;
      });

      await controller.endHumanTurn();

      expect(store.getState().screen).toBe('gameOver');
      expect(soundManager.play).toHaveBeenCalledWith('over');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * turn-cap draw (browser stalemate guard)
   *
   * The engine only ends a game on total conquest, so a stalled AI-vs-AI board would
   * loop forever in the browser. endTurn caps the game at MAX_GAME_TURNS completed
   * player-turns (state.turnsTaken) and ends it as a draw (winner null).
   * -----------------------------------------------------------------------
   */

  describe('turn-cap draw', () => {
    it('ends the game as a draw when END_TURN reaches the turn cap with no winner', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      // END_TURN pushes turnsTaken to the cap with no winner, game still 'playing'. The
      // `config` lets buildGameReplay run so we can assert the draw is still reviewable.
      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'END_TURN') {
          return {
            ...state,
            phase: 'playing',
            winner: null,
            turnsTaken: MAX_GAME_TURNS,
            config: { playerCount: 2 },
          };
        }
        return state;
      });

      await controller.endHumanTurn();

      expect(store.getState().screen).toBe('gameOver');
      expect(store.getState().gameOverReason).toBe('turnLimit');
      expect(store.getState().gameState.winner).toBeNull();
      expect(soundManager.play).toHaveBeenCalledWith('over');
      // A turn-cap draw still builds a reviewable replay (HISTORY button works). This is the
      // `|| drawReason` branch in triggerGameOver — without it, currentReplay would be null.
      expect(store.getState().currentReplay).toBeTruthy();
    });

    it('does not cap a game still under the turn budget', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      // One below the cap → the game must keep running, not jump to gameOver.
      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'END_TURN') {
          return { ...state, phase: 'playing', winner: null, turnsTaken: MAX_GAME_TURNS - 1 };
        }
        return state;
      });

      await controller.endHumanTurn();

      expect(store.getState().screen).not.toBe('gameOver');
      expect(store.getState().gameOverReason ?? null).toBeNull();
    });

    it('caps an AI-vs-AI (spectator) game via the AI turn loop, not just endHumanTurn', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      // Spectator: no human, so the ONLY route to endTurn is runAITurn → endTurn — the
      // path that actually hangs. This proves the cap stops that loop (the real stall),
      // not merely the human END TURN button.
      await controller.startNewGame({ playerCount: 2, spectator: true });

      /*
       * Arm the mock BEFORE acceptMap: acceptMap kicks off the AI turn synchronously
       * (mocked runAI returns null → the AI immediately ends its turn), so the first
       * applyAction(END_TURN) is the AI's. It pushes turnsTaken to the cap with no winner.
       */
      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'END_TURN') {
          return { ...state, phase: 'playing', winner: null, turnsTaken: MAX_GAME_TURNS };
        }
        return state;
      });

      controller.acceptMap();
      // Settle the async AI chain; the cap must END the game, not reschedule another turn.
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(store.getState().screen).toBe('gameOver');
      expect(store.getState().gameOverReason).toBe('turnLimit');
      expect(store.getState().gameState.winner).toBeNull();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * endTurn error handling (I2 fix)
   * -----------------------------------------------------------------------
   */

  describe('endTurn error handling', () => {
    it('sets error in store and navigates to title when applyAction throws', async () => {
      const { applyAction } = await import('../../src/engine/index.js');

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      applyAction.mockImplementationOnce(() => {
        throw new Error('State corrupted');
      });

      controller.endHumanTurn();
      await vi.runAllTimersAsync();

      const state = store.getState();
      expect(state.screen).toBe('title');
      expect(state.error).toBeTruthy();
      expect(state.gameState).toBeNull();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Renderer guard (C2 fix)
   * -----------------------------------------------------------------------
   */

  describe('renderer guard', () => {
    it('sets error when starting game without renderer', async () => {
      const noRendererStore = createGameStore();
      const noRendererController = createGameController(noRendererStore, null, soundManager);

      await noRendererController.startNewGame({ playerCount: 2, spectator: false });

      const state = noRendererStore.getState();
      expect(state.screen).toBe('title');
      expect(state.error).toContain('graphics');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Error messages in catch blocks (C3 fix)
   * -----------------------------------------------------------------------
   */

  describe('error messages in catch blocks', () => {
    it('sets error message on startNewGame failure', async () => {
      const { createGame } = await import('../../src/engine/index.js');
      createGame.mockImplementationOnce(() => {
        throw new Error('Map generation failed');
      });

      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(store.getState().error).toBeTruthy();
      expect(store.getState().screen).toBe('title');
    });

    it('sets error message on rejectMap failure', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });

      const { createGame } = await import('../../src/engine/index.js');
      createGame.mockImplementationOnce(() => {
        throw new Error('Map generation failed');
      });

      await controller.rejectMap();

      expect(store.getState().error).toBeTruthy();
      expect(store.getState().screen).toBe('title');
    });

    it('clears error on successful game start', async () => {
      store.setState({ error: 'Previous error' });

      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(store.getState().error).toBeNull();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Visual effects and reduced motion
   * -----------------------------------------------------------------------
   */

  describe('visual effects and reduced motion', () => {
    it('calls playCelebration on game over when reduced motion is off', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      store.setState({ preferences: { reducedMotion: 'off', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'ATTACK') {
          return {
            ...state,
            phase: 'gameOver',
            winner: 0,
            history: [
              ...state.history,
              {
                type: 'ATTACK',
                from: action.from,
                to: action.to,
                result: {
                  success: true,
                  attackerRoll: { values: [6], total: 6 },
                  defenderRoll: { values: [1], total: 1 },
                },
              },
            ],
          };
        }
        return state;
      });

      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(renderer.playCelebration).toHaveBeenCalledWith(0, expect.any(Object));
      expect(store.getState().screen).toBe('gameOver');
    });

    it('skips playCelebration when reduced motion is on', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      store.setState({ preferences: { reducedMotion: 'on', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'ATTACK') {
          return {
            ...state,
            phase: 'gameOver',
            winner: 0,
            history: [
              ...state.history,
              {
                type: 'ATTACK',
                from: action.from,
                to: action.to,
                result: {
                  success: true,
                  attackerRoll: { values: [6], total: 6 },
                  defenderRoll: { values: [1], total: 1 },
                },
              },
            ],
          };
        }
        return state;
      });

      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(renderer.playCelebration).not.toHaveBeenCalled();
      expect(store.getState().screen).toBe('gameOver');
    });

    it('calls playParticleEffect on successful human attack', async () => {
      store.setState({ preferences: { reducedMotion: 'off', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      // Default applyAction mock returns success for ATTACK
      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(renderer.playParticleEffect).toHaveBeenCalled();
    });

    it('calls screenShake when total dice >= 10', async () => {
      store.setState({ preferences: { reducedMotion: 'off', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      // Give areas high dice so totalDice >= 10
      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: {
            ...gs.areas,
            1: { ...gs.areas[1], dice: 6 },
            2: { ...gs.areas[2], dice: 5 },
          },
        },
      });

      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(renderer.screenShake).toHaveBeenCalled();
    });

    it('skips visual effects when reduced motion is on', async () => {
      store.setState({ preferences: { reducedMotion: 'on', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: {
            ...gs.areas,
            1: { ...gs.areas[1], dice: 6 },
            2: { ...gs.areas[2], dice: 5 },
          },
        },
      });

      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(renderer.playParticleEffect).not.toHaveBeenCalled();
      expect(renderer.screenShake).not.toHaveBeenCalled();
    });

    it('continues to screen shake when particle effect throws', async () => {
      store.setState({ preferences: { reducedMotion: 'off', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      // Give areas high dice so totalDice >= 10
      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: {
            ...gs.areas,
            1: { ...gs.areas[1], dice: 6 },
            2: { ...gs.areas[2], dice: 5 },
          },
        },
      });

      renderer.playParticleEffect.mockImplementation(() => {
        throw new Error('Particle effect broken');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(renderer.screenShake).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Particle'), expect.any(Error));
      errorSpy.mockRestore();
    });

    it('still calls particle effect when screenShake throws', async () => {
      store.setState({ preferences: { reducedMotion: 'off', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: {
            ...gs.areas,
            1: { ...gs.areas[1], dice: 6 },
            2: { ...gs.areas[2], dice: 5 },
          },
        },
      });

      renderer.screenShake.mockImplementation(() => {
        throw new Error('Screen shake broken');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);

      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
        await flushPromises();
      }

      expect(renderer.playParticleEffect).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Screen shake'),
        expect.any(Error)
      );
      errorSpy.mockRestore();
    });

    it('calls animateReinforcements when reinforcements happen', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      store.setState({ preferences: { reducedMotion: 'off', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      /*
       * Mock END_TURN to add dice to area 1 (reinforcement).
       * Use an array for areas so .length works in the reinforcement diff loop.
       */
      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'END_TURN') {
          const prevAreas = state.areas;
          const newAreas = [
            null,
            { ...prevAreas[1], dice: 5 }, // was 3, now 5
            prevAreas[2],
            prevAreas[3],
          ];
          return {
            ...state,
            currentPlayerIndex: 1,
            areas: newAreas,
            history: [...state.history, { type: 'END_TURN' }],
          };
        }
        return state;
      });

      /*
       * Also ensure the current game state uses an array for areas
       * so the diceBefore snapshot loop works
       */
      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: [null, gs.areas[1], gs.areas[2], gs.areas[3]],
        },
      });

      await controller.endHumanTurn();

      expect(renderer.animateReinforcements).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ areaId: 1, oldDice: 3, newDice: 5 })])
      );
    });

    it('skips animateReinforcements when reduced motion is on', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      store.setState({ preferences: { reducedMotion: 'on', animationSpeed: 1 } });

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      applyAction.mockImplementationOnce((state, action) => {
        if (action.type === 'END_TURN') {
          const prevAreas = state.areas;
          const newAreas = [null, { ...prevAreas[1], dice: 5 }, prevAreas[2], prevAreas[3]];
          return {
            ...state,
            currentPlayerIndex: 1,
            areas: newAreas,
            history: [...state.history, { type: 'END_TURN' }],
          };
        }
        return state;
      });

      const gs = store.getState().gameState;
      store.setState({
        gameState: {
          ...gs,
          areas: [null, gs.areas[1], gs.areas[2], gs.areas[3]],
        },
      });

      await controller.endHumanTurn();

      expect(renderer.animateReinforcements).not.toHaveBeenCalled();
      // But renderer.update should still be called
      expect(renderer.update).toHaveBeenCalled();
    });
  });
});
