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
      cancel: vi.fn(),
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

    it('backs out of the map preview without discarding the setup choices (#180)', async () => {
      await controller.startNewGame({
        playerCount: 4,
        spectator: false,
        mapSize: 'large',
        difficulty: 'hard',
        aiAssignments: [null, 'ai_conqueror', 'ai_blitz', 'ai_survivor'],
      });
      expect(store.getState().screen).toBe('mapPreview');

      controller.goToTitle();

      const state = store.getState();
      expect(state.screen).toBe('title');
      expect(state.gameState).toBeNull();
      // The title screen re-seeds itself from config, so the round-trip is lossless.
      expect(state.config).toMatchObject({
        playerCount: 4,
        mapSize: 'large',
        difficulty: 'hard',
        aiAssignments: [null, 'ai_conqueror', 'ai_blitz', 'ai_survivor'],
      });
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Abandoning a game in progress (#181)
   * -----------------------------------------------------------------------
   */

  describe('quit to title', () => {
    /*
     * The engine mocks are module-level and shared with every later test in
     * this file, so any implementation swapped in here is put back afterwards.
     */
    let restoreMocks = [];
    function override(mockFn, implementation) {
      const original = mockFn.getMockImplementation();
      restoreMocks.push(() => mockFn.mockImplementation(original));
      mockFn.mockImplementation(implementation);
    }
    afterEach(() => {
      for (const restore of restoreMocks) restore();
      restoreMocks = [];
    });

    const ATTACK_RESULT = {
      success: true,
      attackerRoll: { values: [6], total: 6 },
      defenderRoll: { values: [1], total: 1 },
    };

    /**
     * Hold the next battle animation open so a quit lands mid-roll, and make the
     * cancel mock do what the real BattleAnimation.cancel() does: resolve the
     * promise play() handed out. With a no-op cancel these tests would pass
     * while the controller left its caller awaiting a promise nobody resolves —
     * exactly the wedge cancel() exists to prevent.
     *
     * @returns {() => void} Release the held animation, as the ticker would.
     */
    function holdBattlePlay() {
      let finishBattle = () => {};
      renderer.battle.play.mockImplementation(
        () =>
          new Promise(resolve => {
            finishBattle = resolve;
          })
      );
      renderer.battle.cancel.mockImplementation(() => finishBattle());
      return () => finishBattle();
    }

    /**
     * Play up to the point where an AI attack is mid-animation.
     *
     * @param {Object} [options]
     * @param {boolean} [options.attackEndsGame] - The attack conquers the board.
     * @param {boolean} [options.eliminatesHuman] - The attack knocks the human out
     *   while the game plays on, which is the AI loop's in-flight hand-off to
     *   triggerGameOver(). Implies a non-spectator game, on the AI's turn.
     */
    async function startAIBattle({ attackEndsGame = false, eliminatesHuman = false } = {}) {
      const { runAI } = await import('../../src/engine/AIAdapter.js');
      const { createGame, getValidMoves, applyAction } = await import('../../src/engine/index.js');

      override(runAI, () => ({ from: 1, to: 2 }));
      override(getValidMoves, () => [{ from: 1, to: 2 }]);
      if (attackEndsGame) {
        override(applyAction, (state, action) => {
          if (action.type !== 'ATTACK') return state;
          return {
            ...state,
            phase: 'gameOver',
            winner: 0,
            history: [...state.history, { type: 'ATTACK', result: ATTACK_RESULT }],
          };
        });
      }
      if (eliminatesHuman) {
        // Start on the AI's turn — slot 0 is the human and would just wait for input.
        override(createGame, () => makeGameState({ currentPlayerIndex: 1 }));
        override(applyAction, (state, action) => {
          if (action.type !== 'ATTACK') return state;
          return {
            ...state,
            // The human is out, but the surviving AIs play on: phase stays 'playing'.
            players: state.players.map((p, i) => (i === 0 ? { ...p, eliminated: true } : p)),
            history: [...state.history, { type: 'ATTACK', result: ATTACK_RESULT }],
          };
        });
      }

      const finishBattle = holdBattlePlay();

      // Spectator by default: every seat is an AI, so player 0's turn runs the loop.
      await controller.startNewGame({ playerCount: 2, spectator: !eliminatesHuman });
      controller.acceptMap();
      await flushPromises();

      expect(renderer.battle.play).toHaveBeenCalled();
      return finishBattle;
    }

    it('opens and closes the confirm only while playing', async () => {
      controller.openQuitConfirm();
      expect(store.getState().quitConfirmOpen).toBe(false); // still on the title

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      controller.openQuitConfirm();
      expect(store.getState().quitConfirmOpen).toBe(true);

      controller.closeQuitConfirm();
      expect(store.getState().quitConfirmOpen).toBe(false);
      // Cancelling changes nothing else: the game is exactly where it was.
      expect(store.getState().screen).toBe('playing');
      expect(store.getState().gameState).toBeTruthy();
      expect(store.getState().awaitingInput).toBe('selectFrom');
    });

    it('confirming from the dialog returns to the title and closes it', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      controller.openQuitConfirm();

      controller.goToTitle();

      expect(store.getState().screen).toBe('title');
      expect(store.getState().quitConfirmOpen).toBe(false);
      expect(store.getState().gameState).toBeNull();
    });

    it('ignores board clicks while the confirm is open', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      // Arm the attack first, so a click that slips through would really attack.
      controller.handleTerritoryClick(1);
      expect(store.getState().awaitingInput).toBe('selectTo');
      controller.openQuitConfirm();

      controller.handleTerritoryClick(2); // area 2 is an enemy neighbour of 1

      expect(applyAction).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'ATTACK' })
      );
      // The half-made attack is untouched: cancelling the dialog resumes it.
      expect(store.getState().selectedFrom).toBe(1);
      expect(store.getState().awaitingInput).toBe('selectTo');
    });

    it('cancels the pending next-turn timer so the title screen stays put', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();

      controller.endHumanTurn(); // schedules startTurn() ~100ms out
      await flushPromises();

      controller.goToTitle();
      await vi.runAllTimersAsync();

      // Without the cancel, startTurn() fires with a null gameState and reads
      // it as a finished game — bouncing the player onto the game-over screen.
      expect(store.getState().screen).toBe('title');
    });

    it('stops the in-flight dice animation', async () => {
      const finishBattle = await startAIBattle();

      controller.goToTitle();
      expect(renderer.battle.cancel).toHaveBeenCalled();

      finishBattle();
      await flushPromises();
    });

    it('drops the open confirm when the game ends underneath it', async () => {
      // The dialog does not pause play: an AI can finish the game while it is up.
      const finishBattle = await startAIBattle({ attackEndsGame: true });
      controller.openQuitConfirm();
      expect(store.getState().quitConfirmOpen).toBe(true);

      finishBattle();
      await vi.runAllTimersAsync();
      await flushPromises();

      expect(store.getState().screen).toBe('gameOver');
      // Otherwise a later Spectate (back to 'playing') would resurrect a stale dialog.
      expect(store.getState().quitConfirmOpen).toBe(false);
    });

    it('abandoning mid-AI-turn drops the rest of the attack and the loop', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      // A non-terminal attack: the loop would otherwise take another move.
      const finishBattle = await startAIBattle();

      controller.goToTitle();
      applyAction.mockClear();
      renderer.hexGrid.clearHighlights.mockClear();

      finishBattle();
      await vi.runAllTimersAsync();
      await flushPromises();

      expect(store.getState().screen).toBe('title');
      expect(store.getState().gameState).toBeNull();
      // Everything the rest of the iteration would have done to the title screen.
      expect(soundManager.play).not.toHaveBeenCalledWith('success');
      expect(soundManager.play).not.toHaveBeenCalledWith('fail');
      expect(renderer.playParticleEffect).not.toHaveBeenCalled();
      expect(applyAction).not.toHaveBeenCalled(); // no further move, no end of turn
      // The abandoned attack leaves no highlight on the canvas behind the title.
      expect(renderer.hexGrid.clearHighlights).toHaveBeenCalled();
    });

    it('abandoning the attack that eliminates the human skips the game-over hand-off', async () => {
      // Non-spectator: this is the one place the AI loop calls triggerGameOver mid-turn.
      const finishBattle = await startAIBattle({ eliminatesHuman: true });

      controller.goToTitle();

      finishBattle();
      await vi.runAllTimersAsync();
      await flushPromises();

      expect(store.getState().screen).toBe('title');
      expect(store.getState().humanEliminated).toBe(false);
      expect(renderer.playCelebration).not.toHaveBeenCalled();
      expect(soundManager.play).not.toHaveBeenCalledWith('over');
      expect(soundManager.play).not.toHaveBeenCalledWith('success');
      expect(renderer.playParticleEffect).not.toHaveBeenCalled();
    });

    it('abandoning a human attack mid-roll does not re-arm input on the title', async () => {
      const finishBattle = holdBattlePlay();
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      controller.handleTerritoryClick(1); // pick the attacker
      controller.handleTerritoryClick(2); // ...and the target: the roll starts
      await flushPromises();
      expect(renderer.battle.play).toHaveBeenCalled();

      controller.goToTitle();

      finishBattle();
      await vi.runAllTimersAsync();
      await flushPromises();

      expect(store.getState().screen).toBe('title');
      // Re-arming would leave the title screen listening for the next click of an
      // abandoned attack (and the sting would play over the menu).
      expect(store.getState().awaitingInput).toBeNull();
      expect(soundManager.play).not.toHaveBeenCalledWith('success');
      expect(renderer.playParticleEffect).not.toHaveBeenCalled();
    });

    it('abandoning the winning human attack mid-roll skips the game-over screen', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      override(applyAction, (state, action) => {
        if (action.type !== 'ATTACK') return state;
        return {
          ...state,
          phase: 'gameOver',
          winner: 0,
          history: [...state.history, { type: 'ATTACK', result: ATTACK_RESULT }],
        };
      });
      const finishBattle = holdBattlePlay();
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      controller.handleTerritoryClick(1);
      controller.handleTerritoryClick(2);
      await flushPromises();

      controller.goToTitle();

      finishBattle();
      await vi.runAllTimersAsync();
      await flushPromises();

      expect(store.getState().screen).toBe('title');
      expect(store.getState().gameState).toBeNull();
      expect(renderer.playCelebration).not.toHaveBeenCalled();
      expect(soundManager.play).not.toHaveBeenCalledWith('over');
      expect(soundManager.play).not.toHaveBeenCalledWith('success');
    });

    it('quitting during the reinforcement flash does not schedule another turn', async () => {
      const { createGame, applyAction } = await import('../../src/engine/index.js');
      /*
       * The shared game state indexes areas by key; the reinforcement diff walks
       * `areas.length`, so this test needs a real array with a real dice change
       * to reach `await renderer.animateReinforcements()` at all.
       */
      const baseApplyAction = applyAction.getMockImplementation();
      override(createGame, () =>
        makeGameState({
          areas: [
            null,
            { owner: 0, dice: 3, neighborAreaIds: [2, 3] },
            { owner: 1, dice: 2, neighborAreaIds: [1, 3] },
            { owner: 0, dice: 1, neighborAreaIds: [1, 2] },
          ],
        })
      );
      override(applyAction, (state, action) => {
        const next = baseApplyAction(state, action);
        if (action.type !== 'END_TURN') return next;
        return { ...next, areas: next.areas.map((a, i) => (i === 1 && a ? { ...a, dice: 8 } : a)) };
      });

      let finishReinforcements;
      renderer.animateReinforcements.mockImplementation(
        () =>
          new Promise(resolve => {
            finishReinforcements = resolve;
          })
      );

      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      controller.endHumanTurn();
      await flushPromises();
      expect(renderer.animateReinforcements).toHaveBeenCalled();

      controller.goToTitle();

      finishReinforcements();
      await vi.runAllTimersAsync();
      await flushPromises();

      /*
       * The flash runs with animationPhase already 'idle', so QUIT is live across
       * it. Resuming would schedule startTurn() with a null gameState — which
       * reads as a finished game and lands on the game-over screen.
       */
      expect(store.getState().screen).toBe('title');
      expect(store.getState().gameState).toBeNull();
    });

    it('quitting during the win celebration leaves the title screen alone', async () => {
      let finishCelebration;
      renderer.playCelebration.mockImplementation(
        () =>
          new Promise(resolve => {
            finishCelebration = resolve;
          })
      );
      const finishBattle = await startAIBattle({ attackEndsGame: true });

      finishBattle();
      await flushPromises();
      expect(renderer.playCelebration).toHaveBeenCalled();

      controller.goToTitle();

      finishCelebration();
      await vi.runAllTimersAsync();
      await flushPromises();

      // The celebration holds 'playing' for 1.5s, so the quit lands inside it.
      expect(store.getState().screen).toBe('title');
      expect(store.getState().gameState).toBeNull();
      expect(store.getState().currentReplay).toBeNull();
      expect(soundManager.play).not.toHaveBeenCalledWith('over');
    });

    it('the next game after a mid-battle quit still runs its AI', async () => {
      const { runAI } = await import('../../src/engine/AIAdapter.js');
      await startAIBattle();

      controller.goToTitle(); // cancel() releases the roll the AI loop is awaiting
      await flushPromises();

      // A second game: its loop can only start if the first one let go of aiRunning.
      runAI.mockImplementation(() => null); // end the turn immediately this time
      renderer.battle.play.mockImplementation(async () => {});
      renderer.battle.cancel.mockImplementation(() => {});
      runAI.mockClear();

      await controller.startNewGame({ playerCount: 2, spectator: true });
      controller.acceptMap();
      await flushPromises();

      expect(runAI).toHaveBeenCalled();
    });

    it('clears the board highlight and keyboard focus a half-made attack left behind', async () => {
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      controller.handleTerritoryClick(1); // gold outline on the canvas
      store.setState({ focusedAreaId: 1 }); // as keyboard navigation would
      renderer.hexGrid.clearHighlights.mockClear();

      controller.goToTitle();

      // drawMap() doesn't clear highlights, so the outline would sit over the attract board.
      expect(renderer.hexGrid.clearHighlights).toHaveBeenCalled();
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('an engine failure on the way to the title takes the confirm with it', async () => {
      const { applyAction } = await import('../../src/engine/index.js');
      const baseApplyAction = applyAction.getMockImplementation();
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      controller.openQuitConfirm();
      override(applyAction, (state, action) => {
        if (action.type === 'END_TURN') throw new Error('engine blew up');
        return baseApplyAction(state, action);
      });

      controller.endHumanTurn();
      await vi.runAllTimersAsync();
      await flushPromises();

      expect(store.getState().screen).toBe('title');
      // Otherwise the next game opens with "Abandon this game?" already up.
      expect(store.getState().quitConfirmOpen).toBe(false);
    });

    it('a failed game start takes the confirm with it', async () => {
      const { createGame } = await import('../../src/engine/index.js');
      await controller.startNewGame({ playerCount: 2, spectator: false });
      controller.acceptMap();
      controller.openQuitConfirm();
      override(createGame, () => {
        throw new Error('map generation blew up');
      });

      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(store.getState().screen).toBe('title');
      expect(store.getState().quitConfirmOpen).toBe(false);
    });

    it('a new game never inherits an open confirm or a stale focus', async () => {
      // Belt and braces: whatever left these set, the new game starts clean.
      store.setState({ quitConfirmOpen: true, focusedAreaId: 3 });

      await controller.startNewGame({ playerCount: 2, spectator: false });

      expect(store.getState().quitConfirmOpen).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
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
