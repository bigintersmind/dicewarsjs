// @vitest-environment jsdom
import { createGameController } from '../../src/controller/GameController.js';
import { createGameStore } from '../../src/store/GameStore.js';
import { createDailyChallenge } from '../../src/game/dailyChallenge.js';
import { readDailyRecord } from '../../src/store/dailyRecords.js';
import { getAIImplementation } from '../../src/ai/aiConfig.js';
import { findLargestConnectedGroup } from '../../src/engine/index.js';
import { createMatchJournal } from '../../src/game/matchJournal.js';

vi.mock('../../src/ai/aiConfig.js', async original => ({
  ...(await original()),
  getAIImplementation: vi.fn(async () => () => 0),
}));

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

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
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

  it('counts a winning partial turn and saves the victory from the resolved human attack', async () => {
    const { store, controller } = setup();
    await controller.startDailyGame('2026-09-07');
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
      matchJournal: { won: true, turns: 1, attacks: 1, captures: 1 },
    });
    expect(readDailyRecord(createDailyChallenge('2026-09-07').id).record).toEqual({
      completed: 1,
      wins: 1,
      bestTurns: 1,
    });
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
    });
    const frozen = store.getState().matchJournal;
    store.setState({ gameState: { ...store.getState().gameState, turnsTaken: 299 } });
    await controller.startSpectate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState()).toMatchObject({ screen: 'gameOver', gameOverReason: 'turnLimit' });
    expect(store.getState().matchJournal).toBe(frozen);
    expect(readDailyRecord(createDailyChallenge('2026-09-07').id).record.completed).toBe(1);
  });

  it('uses the canonical fair setup and preserves Custom preferences on the return home', async () => {
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
    await controller.rejectMap();
    expect(store.getState().gameState).toBe(first);
    controller.goToTitle();
    expect(store.getState()).toMatchObject({ config, dailyChallenge: null, matchJournal: null });
    await controller.startDailyGame('2026-09-07');
    expect(store.getState().gameState).toEqual(first);
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
    expect(store.getState().gameState).toEqual(first);
    expect(store.getState().dailyChallenge.date).toBe('2026-09-07');
    expect(store.getState().matchJournal).toMatchObject({ turns: 0, attacks: 0, finished: false });
    expect(store.getState().currentReplay).toBeNull();
  });

  it('ordinary retries use the accepted rerolled map and keep the luck and lineup', async () => {
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
    await controller.rejectMap();
    const accepted = store.getState().gameState;
    expect(accepted.config.seed).not.toBe(firstSeed);
    store.setState({ screen: 'gameOver' });
    await controller.retryGame();
    expect(store.getState().gameState).toEqual(accepted);
    expect(store.getState().gameState.config.handicap).toEqual({ playerId: 0, level: 2 });
    expect(store.getState().dailyChallenge).toBeNull();
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
    expect(readDailyRecord(daily.id).record).toEqual({ completed: 1, wins: 0, bestTurns: null });
    controller.viewGameReplay();
    controller.goBackFromReplay();
    expect(readDailyRecord(daily.id).record.completed).toBe(1);
    controller.goToTitle();
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
});
