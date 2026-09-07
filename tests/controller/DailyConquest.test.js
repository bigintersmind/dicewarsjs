// @vitest-environment jsdom
import { createGameController } from '../../src/controller/GameController.js';
import { createGameStore } from '../../src/store/GameStore.js';
import { createDailyChallenge } from '../../src/game/dailyChallenge.js';
import { readDailyRecord } from '../../src/store/dailyRecords.js';
import { getAIImplementation } from '../../src/ai/aiConfig.js';
import { DIFFICULTY_MODES } from '../../src/ai/difficultyModes.js';
import { findLargestConnectedGroup, getValidMoves } from '../../src/engine/index.js';
import { createMatchJournal } from '../../src/game/matchJournal.js';

vi.mock('../../src/ai/aiConfig.js', async original => ({
  ...(await original()),
  getAIImplementation: vi.fn(async () => () => 0),
}));

/*
 * The leaderboard client is exercised for real — its own suite covers the HTTP
 * surface, and re-stubbing that here would test the stub. Only its two
 * ambient inputs are injected: the base URL (this build has none configured, so
 * an unmocked call would reject as `disabled` before reaching any fetch) and
 * the fetch itself. `vi.hoisted` because the factory runs during the hoisted
 * import of GameController, before this file's own consts exist.
 */
const leaderboard = vi.hoisted(() => ({ url: 'https://leaderboard.example', fetch: null }));
vi.mock('../../src/game/dailyLeaderboard.js', async original => {
  const actual = await original();
  return {
    ...actual,
    submitDailyResult: (result, options) =>
      actual.submitDailyResult(result, {
        url: leaderboard.url,
        fetch: leaderboard.fetch,
        ...options,
      }),
  };
});

function respondWith({ status = 200, body = {} } = {}) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }));
}

function setup(overrides) {
  const store = createGameStore({
    preferences: { reducedMotion: 'on', boardHints: 'on' },
    ...overrides,
  });
  const renderer = {
    initialized: true,
    drawMap: vi.fn(),
    update: vi.fn(),
    hexGrid: {
      clearFocusHighlight: vi.fn(),
      clearHighlights: vi.fn(),
      clearSelectionHighlights: vi.fn(),
      setCandidateHighlights: vi.fn(),
      clearCandidateHighlights: vi.fn(),
      setHighlight: vi.fn(),
    },
    battle: { play: vi.fn(async () => {}), cancel: vi.fn() },
  };
  const controller = createGameController(store, renderer, null);
  return { store, renderer, controller };
}

/** Play one human attack through the controller's own two-click path. */
async function humanAttack(store, controller) {
  const move = getValidMoves(store.getState().gameState)[0];
  expect(move).toBeDefined();
  controller.handleTerritoryClick(move.from);
  controller.handleTerritoryClick(move.to);
  await vi.advanceTimersByTimeAsync(1);
  return move;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  localStorage.clear();
  leaderboard.url = 'https://leaderboard.example';
  leaderboard.fetch = respondWith();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Daily Conquest controller with the real engine', () => {
  // A legal, decisive 8-v-1 position: no roll can fail, while resolution and turn logic stay real.
  function decisivePosition(state, winningSeat) {
    const source = state.areas.find(
      a => a.size > 0 && a.neighborAreaIds.some(id => state.areas[id]?.size > 0)
    );
    const to = source.neighborAreaIds.find(id => state.areas[id]?.size > 0);
    const areas = state.areas.map(a => ({
      ...a,
      owner:
        winningSeat === 0
          ? a.id === to
            ? 1
            : 0
          : a.id === to
            ? 0
            : a.id === source.id
              ? 1
              : a.owner === 0
                ? 2
                : a.owner,
      dice: a.id === source.id ? 8 : a.id === to ? 1 : a.dice,
    }));
    const players = state.players.map(p => {
      const owned = areas.filter(a => a.size > 0 && a.owner === p.id);
      return {
        ...p,
        territoryCount: owned.length,
        diceCount: owned.reduce((sum, a) => sum + a.dice, 0),
        largestGroup: findLargestConnectedGroup(areas, p.id),
        eliminated: owned.length === 0,
      };
    });
    return {
      state: { ...state, areas, players, currentPlayerIndex: state.turnOrder.indexOf(winningSeat) },
      from: source.id,
      to,
    };
  }

  /** Start a daily and play it to a human victory; returns the finished store. */
  async function finishDailyWin(store, controller, date = '2026-09-07') {
    await controller.startDailyGame(date);
    const { state, from, to } = decisivePosition(store.getState().gameState, 0);
    store.setState({
      gameState: state,
      screen: 'playing',
      awaitingInput: 'selectFrom',
      matchJournal: createMatchJournal(state, 0),
    });
    controller.handleTerritoryClick(from);
    controller.handleTerritoryClick(to);
    await vi.advanceTimersByTimeAsync(1);
  }

  it('counts a winning partial turn and scores the attempt from the resolved human attack', async () => {
    const { store, controller } = setup();
    await finishDailyWin(store, controller);
    expect(store.getState()).toMatchObject({
      screen: 'gameOver',
      matchJournal: { won: true, turns: 1, attacks: 1, captures: 1 },
      dailyResult: { available: true, official: true, streak: 1 },
    });
    const { record } = readDailyRecord(createDailyChallenge('2026-09-07').id);
    expect(record).toMatchObject({
      practice: 0,
      official: { won: true, turns: 1, attacks: 1, captures: 1, submission: null },
    });
    // The replay travels with the result so it can be verified server-side later.
    expect(record.official.replay).toBeTruthy();
  });

  it('pins the daily lineup to ai_default through the loader, whatever the player last chose', async () => {
    const { store, controller } = setup({
      config: {
        playerCount: 8,
        mapSize: 'large',
        difficulty: 'hard',
        luck: 0,
        aiAssignments: [...DIFFICULTY_MODES.hard.lineup],
      },
    });
    await controller.startDailyGame('2026-09-07');
    // Not just the recipe's own field: what the AI loader was actually asked for.
    expect(getAIImplementation.mock.calls.map(([id]) => id)).toEqual([
      'ai_default',
      'ai_default',
      'ai_default',
    ]);
    expect(store.getState().gameState.config.playerCount).toBe(4);
    // ...and no persona weight chunk was pulled in for a Hard-lineup player.
    expect(store.getState().playerNames).toHaveLength(4);
  });

  it('counts a human turn once per turn, across the AI cycle in between', async () => {
    const { store, controller } = setup();
    await controller.startDailyGame('2026-09-07');
    const state = store.getState().gameState;
    store.setState({
      gameState: { ...state, currentPlayerIndex: state.turnOrder.indexOf(0) },
      screen: 'playing',
      awaitingInput: 'selectFrom',
    });

    await humanAttack(store, controller);
    expect(store.getState().matchJournal).toMatchObject({ turns: 1, attacks: 1 });

    // A second attack in the SAME turn is another attack, not another turn.
    await humanAttack(store, controller);
    expect(store.getState().matchJournal).toMatchObject({ turns: 1, attacks: 2 });

    controller.endHumanTurn();
    await vi.advanceTimersByTimeAsync(2000); // the three AI seats pass
    expect(
      store.getState().gameState.turnOrder[store.getState().gameState.currentPlayerIndex]
    ).toBe(0);

    await humanAttack(store, controller);
    expect(store.getState().matchJournal).toMatchObject({ turns: 2, attacks: 3 });
    expect(store.getState().screen).toBe('playing');
  });

  it('freezes an early elimination and does not count spectating to a draw as another attempt', async () => {
    let attack;
    getAIImplementation.mockResolvedValueOnce(game => {
      if (!attack) return 0;
      game.area_from = attack.from;
      game.area_to = attack.to;
      attack = null;
      return 1;
    });
    const { store, controller } = setup();
    await controller.startDailyGame('2026-09-07');
    const position = decisivePosition(store.getState().gameState, 1);
    attack = position;
    store.setState({
      gameState: position.state,
      matchJournal: createMatchJournal(position.state, 0),
    });
    controller.acceptMap();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({
      screen: 'gameOver',
      humanEliminated: true,
      matchJournal: { finished: true, won: false, turns: 0 },
      dailyResult: { official: true, available: true },
    });
    // A loss by elimination is the most common daily result. It must carry the
    // game-so-far replay so it can be posted and re-verified like a win or a draw.
    expect(store.getState().currentReplay).toMatchObject({ actions: expect.any(Array) });
    expect(
      readDailyRecord(createDailyChallenge('2026-09-07').id).record.official.replay
    ).toMatchObject({ actions: expect.any(Array) });
    const frozen = store.getState().matchJournal;
    store.setState({ gameState: { ...store.getState().gameState, turnsTaken: 299 } });
    await controller.startSpectate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState()).toMatchObject({ screen: 'gameOver', gameOverReason: 'turnLimit' });
    expect(store.getState().matchJournal).toBe(frozen);
    expect(readDailyRecord(createDailyChallenge('2026-09-07').id).record.practice).toBe(0);
  });

  it('uses the canonical fair setup, refuses a reroll out loud, and preserves Custom preferences', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = {
      playerCount: 8,
      mapSize: 'large',
      difficulty: 'custom',
      luck: 2,
      aiAssignments: [null, 'ai_conqueror'],
    };
    const { store, controller } = setup({ config });
    await controller.startDailyGame('2026-09-07');
    const first = store.getState().gameState;
    expect(first.config).toMatchObject({
      playerCount: 4,
      mapWidth: 20,
      mapHeight: 24,
      handicap: null,
    });
    expect(store.getState().config).toEqual(config);
    expect(store.getState().playerNames).toHaveLength(4);
    expect(store.getState().dailyChallenge).toMatchObject({ date: '2026-09-07', practice: false });

    await controller.rejectMap();
    expect(store.getState().gameState).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('daily boards cannot be rerolled'));

    controller.goToTitle();
    expect(store.getState()).toMatchObject({
      config,
      dailyChallenge: null,
      dailyResult: null,
      matchJournal: null,
      noValidMoves: false,
    });
    await controller.startDailyGame('2026-09-07');
    expect(store.getState().gameState).toEqual(first);
  });

  it('scores the first attempt only: a retry is practice, played straight from the result screen', async () => {
    const { store, controller } = setup();
    await finishDailyWin(store, controller);
    const id = createDailyChallenge('2026-09-07').id;
    const official = readDailyRecord(id).record.official;
    expect(store.getState().dailyResult.official).toBe(true);

    await controller.retryGame();
    expect(store.getState()).toMatchObject({
      screen: 'playing', // PRACTICE AGAIN goes back to the board, not the preview
      dailyChallenge: { date: '2026-09-07', practice: true },
      dailyResult: null,
      matchJournal: { turns: 0, attacks: 0, finished: false },
      currentReplay: null,
    });

    // Finish the practice run: counted, never scored.
    const { state, from, to } = decisivePosition(store.getState().gameState, 0);
    store.setState({
      gameState: state,
      awaitingInput: 'selectFrom',
      matchJournal: createMatchJournal(state, 0),
    });
    controller.handleTerritoryClick(from);
    controller.handleTerritoryClick(to);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({
      screen: 'gameOver',
      dailyResult: { official: false, available: true, record: { practice: 1 } },
    });
    expect(readDailyRecord(id).record.official).toEqual(official);
  });

  it('retries yesterday’s board after midnight and resets the finished journal', async () => {
    const { store, controller } = setup();
    await controller.startDailyGame('2026-09-07');
    const first = store.getState().gameState;
    store.setState({
      screen: 'gameOver',
      matchJournal: { finished: true },
      currentReplay: { old: true },
    });
    vi.setSystemTime(new Date('2026-09-08T03:00:00Z'));
    await controller.retryGame();
    expect(store.getState().gameState.config.seed).toBe(first.config.seed);
    expect(store.getState().dailyChallenge.date).toBe('2026-09-07');
    expect(store.getState().matchJournal).toMatchObject({ turns: 0, attacks: 0, finished: false });
    expect(store.getState().currentReplay).toBeNull();
    expect(store.getState().screen).toBe('playing');
  });

  it('ordinary retries use the accepted rerolled map, keep the luck and lineup, and skip the preview', async () => {
    const { store, controller } = setup();
    await controller.startNewGame({
      playerCount: 2,
      spectator: false,
      mapSize: 'small',
      difficulty: 'custom',
      luck: 2,
      aiAssignments: [null, 'ai_default'],
    });
    const firstSeed = store.getState().gameState.config.seed;
    store.setState({ matchJournal: { finished: true, turns: 9 } });
    await controller.rejectMap();
    // NEW MAP is a new game for the report as well as the board.
    expect(store.getState().matchJournal).toMatchObject({ turns: 0, finished: false });
    const accepted = store.getState().gameState;
    expect(accepted.config.seed).not.toBe(firstSeed);

    store.setState({ screen: 'gameOver' });
    await controller.retryGame();
    expect(store.getState().gameState.config.seed).toBe(accepted.config.seed);
    expect(store.getState().gameState.config.handicap).toEqual({ playerId: 0, level: 2 });
    expect(store.getState()).toMatchObject({ screen: 'playing', dailyChallenge: null });
  });

  it('records a draw only once, using human turns, and replay navigation does not add attempts', async () => {
    const { store, controller } = setup();
    await controller.startDailyGame('2026-09-07');
    const daily = store.getState().dailyChallenge;
    const state = store.getState().gameState;
    store.setState({
      gameState: { ...state, currentPlayerIndex: state.turnOrder.indexOf(0), turnsTaken: 299 },
      screen: 'playing',
      awaitingInput: 'selectFrom',
    });
    controller.endHumanTurn();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState()).toMatchObject({
      screen: 'gameOver',
      gameOverReason: 'turnLimit',
      matchJournal: { finished: true, turns: 1 },
    });
    // The stored result tells a draw apart from an elimination for the title card.
    expect(readDailyRecord(daily.id).record.official).toMatchObject({
      won: false,
      drew: true,
      turns: 1,
    });
    controller.viewGameReplay();
    controller.goBackFromReplay();
    expect(readDailyRecord(daily.id).record.practice).toBe(0);
    controller.goToTitle();
  });

  it('reaches the game-over screen even when the browser refuses to store the result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, controller } = setup();
    await controller.startDailyGame('2026-09-07');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { state, from, to } = decisivePosition(store.getState().gameState, 0);
    store.setState({
      gameState: state,
      screen: 'playing',
      awaitingInput: 'selectFrom',
      matchJournal: createMatchJournal(state, 0),
    });
    controller.handleTerritoryClick(from);
    controller.handleTerritoryClick(to);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({
      screen: 'gameOver',
      matchJournal: { won: true, finished: true },
      dailyResult: { available: false, official: true, record: null, streak: 0 },
    });
    expect(warn).toHaveBeenCalled();
  });

  it('does not count an abandoned attempt or create a human journal for spectator games', async () => {
    const { store, controller } = setup();
    await controller.startDailyGame('2026-09-07');
    controller.goToTitle();
    expect(readDailyRecord(createDailyChallenge('2026-09-07').id).record).toBeNull();
    await controller.startNewGame({
      playerCount: 2,
      spectator: true,
      aiAssignments: [null, 'ai_default'],
    });
    expect(store.getState()).toMatchObject({ matchJournal: null, dailyChallenge: null });
  });

  it('leaving while bots load prevents a late start from reclaiming the title', async () => {
    const { store, controller } = setup();
    let release;
    getAIImplementation.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const pending = controller.startDailyGame('2026-09-07');
    controller.goToTitle();
    release(() => 0);
    await pending;
    expect(store.getState()).toMatchObject({
      screen: 'title',
      gameState: null,
      dailyChallenge: null,
    });
  });

  describe('routes back to the title', () => {
    /** Pretend a daily match is in progress with a result and a dead end on screen. */
    function midDaily(store) {
      store.setState({
        dailyChallenge: { id: 'daily-v1-2026-09-07', date: '2026-09-07', practice: false },
        dailyResult: { available: true, official: true, record: {}, streak: 4 },
        matchJournal: { turns: 3, finished: false },
        noValidMoves: true,
      });
    }
    const cleared = {
      screen: 'title',
      dailyChallenge: null,
      dailyResult: null,
      matchJournal: null,
      noValidMoves: false,
    };

    it('clears the daily match on a bad luck rung', async () => {
      const { store, controller } = setup();
      midDaily(store);
      await controller.startNewGame({
        playerCount: 2,
        spectator: false,
        difficulty: 'custom',
        luck: 99,
      });
      expect(store.getState()).toMatchObject(cleared);
      expect(store.getState().error).toMatch(/luck setting/);
    });

    it('clears the daily match when the bots cannot load', async () => {
      const { store, controller } = setup();
      midDaily(store);
      getAIImplementation.mockRejectedValue(new Error('offline'));
      await controller.startNewGame({
        playerCount: 2,
        spectator: false,
        aiAssignments: [null, 'ai_default'],
      });
      expect(store.getState()).toMatchObject(cleared);
    });

    it('clears the daily match when NEW MAP hits an impossible luck rung', async () => {
      const { store, controller } = setup();
      await controller.startNewGame({
        playerCount: 2,
        spectator: false,
        aiAssignments: [null, 'ai_default'],
      });
      midDaily(store); // ...as if the daily state had somehow survived into an ordinary game
      store.setState({
        dailyChallenge: null,
        config: { ...store.getState().config, difficulty: 'custom', luck: 99 },
      });
      await controller.rejectMap();
      expect(store.getState()).toMatchObject({ ...cleared, dailyChallenge: null });
    });

    it('clears the daily match on an engine error at end of turn', async () => {
      const { store, controller } = setup();
      await controller.startDailyGame('2026-09-07');
      store.setState({
        screen: 'playing',
        awaitingInput: 'selectFrom',
        gameState: { ...store.getState().gameState, phase: 'gameOver' },
      });
      controller.endHumanTurn();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState()).toMatchObject({ ...cleared, gameState: null, playerNames: [] });
      expect(store.getState().error).toMatch(/Returning to title/);
    });

    it('reports an impossible daily date instead of throwing out of the button', async () => {
      const { store, controller } = setup();
      midDaily(store);
      await expect(controller.startDailyGame('2026-02-30')).resolves.toBeUndefined();
      expect(store.getState()).toMatchObject(cleared);
      expect(store.getState().error).toMatch(/daily board/);
    });
  });

  describe('the dead end', () => {
    /** A board where the human owns everything worth one die: no legal attack. */
    function deadEnd(state) {
      const areas = state.areas.map(a => (a.size > 0 && a.owner === 0 ? { ...a, dice: 1 } : a));
      return { ...state, areas, currentPlayerIndex: state.turnOrder.indexOf(0) };
    }

    it('flags a turn with no legal attack, whatever the hint preference says', async () => {
      for (const boardHints of ['on', 'off']) {
        const { store, controller } = setup({
          preferences: { reducedMotion: 'on', boardHints },
        });
        await controller.startDailyGame('2026-09-07');
        store.setState({
          gameState: deadEnd(store.getState().gameState),
          screen: 'playing',
          awaitingInput: 'selectFrom',
        });
        controller.refreshCandidateHighlights();
        expect(getValidMoves(store.getState().gameState)).toHaveLength(0);
        expect(store.getState().noValidMoves).toBe(true);
        // The hints themselves still answer to the preference.
        expect(store.getState().candidateAreas).toEqual(boardHints === 'on' ? [] : null);
      }
    });

    it('is false on a live turn, on an AI’s turn, and for a spectator', async () => {
      const { store, controller } = setup();
      await controller.startDailyGame('2026-09-07');
      const state = store.getState().gameState;
      store.setState({
        gameState: { ...state, currentPlayerIndex: state.turnOrder.indexOf(0) },
        screen: 'playing',
        awaitingInput: 'selectFrom',
      });
      controller.refreshCandidateHighlights();
      expect(store.getState().noValidMoves).toBe(false);

      // The same dead-end board, but it is an opponent's move.
      const stuck = deadEnd(store.getState().gameState);
      store.setState({
        gameState: { ...stuck, currentPlayerIndex: stuck.turnOrder.indexOf(1) },
        awaitingInput: null,
      });
      controller.refreshCandidateHighlights();
      expect(store.getState().noValidMoves).toBe(false);

      store.setState({
        gameState: stuck,
        awaitingInput: 'selectFrom',
        humanPlayerIndex: null,
      });
      controller.refreshCandidateHighlights();
      expect(store.getState().noValidMoves).toBe(false);
    });
  });

  describe('submitDailyScore', () => {
    const posted = {
      accepted: true,
      won: true,
      turns: 1,
      rank: 4,
      totals: { finished: 12, won: 5 },
    };

    async function finishedDaily() {
      const harness = setup();
      await finishDailyWin(harness.store, harness.controller);
      return harness;
    }

    it('posts the replay, stores the rank, and returns the server’s answer', async () => {
      const { store, controller } = await finishedDaily();
      leaderboard.fetch = respondWith({ status: 201, body: posted });

      await expect(controller.submitDailyScore('  Ada  ')).resolves.toEqual(posted);
      const [url, init] = leaderboard.fetch.mock.calls[0];
      expect(url).toBe('https://leaderboard.example/daily/2026-09-07/results');
      expect(JSON.parse(init.body)).toMatchObject({ version: 1, name: 'Ada' });
      expect(JSON.parse(init.body).replay).toEqual(store.getState().currentReplay);

      const submission = { name: 'Ada', rank: 4 };
      expect(store.getState().dailyResult.record.official.submission).toEqual(submission);
      expect(
        readDailyRecord(createDailyChallenge('2026-09-07').id).record.official.submission
      ).toEqual(submission);
    });

    it('refuses an unusable name before any request', async () => {
      const { controller } = await finishedDaily();
      await expect(controller.submitDailyScore('   ')).rejects.toMatchObject({
        code: 'name_rejected',
        message: expect.stringContaining('1-16'),
      });
      expect(leaderboard.fetch).not.toHaveBeenCalled();
    });

    it('refuses to submit a practice run, or a result there is no replay for', async () => {
      const { store, controller } = await finishedDaily();
      store.setState({ dailyResult: { ...store.getState().dailyResult, official: false } });
      await expect(controller.submitDailyScore('Ada')).rejects.toMatchObject({
        code: 'not_submittable',
      });

      store.setState({
        dailyResult: { ...store.getState().dailyResult, official: true },
        currentReplay: null,
      });
      await expect(controller.submitDailyScore('Ada')).rejects.toMatchObject({
        code: 'not_submittable',
      });
      expect(leaderboard.fetch).not.toHaveBeenCalled();
    });

    it('surfaces a rejected or unreachable leaderboard, leaving the record unsubmitted', async () => {
      const { store, controller } = await finishedDaily();
      const id = createDailyChallenge('2026-09-07').id;

      for (const [status, code] of [
        [400, 'wrong_board'],
        [400, 'unverifiable'],
        [400, 'not_finished'],
        [400, 'date_closed'],
        [429, 'rate_limited'],
      ]) {
        leaderboard.fetch = respondWith({ status, body: { error: code } });
        const err = await controller.submitDailyScore('Ada').catch(e => e);
        expect(err.code).toBe(code);
        expect(err.message.length).toBeGreaterThan(10);
      }

      leaderboard.fetch = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      await expect(controller.submitDailyScore('Ada')).rejects.toMatchObject({ code: 'network' });

      expect(readDailyRecord(id).record.official.submission).toBeNull();
      expect(store.getState().dailyResult.record.official.submission).toBeNull();
    });

    it('rejects as disabled when the build has no leaderboard configured', async () => {
      const { controller } = await finishedDaily();
      leaderboard.url = null;
      await expect(controller.submitDailyScore('Ada')).rejects.toMatchObject({ code: 'disabled' });
      expect(leaderboard.fetch).not.toHaveBeenCalled();
    });
  });
});
