/**
 * TitleAttractMode tests
 *
 * The background AI game behind the title and bot-hub screens: it must draw
 * and advance a private engine game on a timer, honor reduced motion, survive
 * a missing renderer, and start/stop strictly with the attract screens.
 */

import {
  createTitleAttractMode,
  ATTACK_STEP_MS,
  END_TURN_STEP_MS,
  ROUND_RESTART_MS,
} from '../../src/controller/TitleAttractMode.js';
import { createGameStore } from '../../src/store/GameStore.js';

/** Longest single-tick delay — advancing by this always fires a pending tick. */
const MAX_STEP_MS = Math.max(ATTACK_STEP_MS, END_TURN_STEP_MS);

function makeRenderer() {
  return {
    initialized: true,
    drawMap: vi.fn(),
    update: vi.fn(),
  };
}

function makePrefs({ reduced = false } = {}) {
  return {
    effectiveReducedMotion: vi.fn(() => reduced),
    subscribe: vi.fn(() => () => {}),
  };
}

/** Sum of board-draw + step calls, to detect any renderer activity. */
const renderCalls = renderer =>
  renderer.drawMap.mock.calls.length + renderer.update.mock.calls.length;

describe('TitleAttractMode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() generates a game and draws it', async () => {
    const renderer = makeRenderer();
    const mode = createTitleAttractMode({ store: createGameStore(), renderer });

    await mode.start();

    expect(mode.isRunning()).toBe(true);
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);
    const state = renderer.drawMap.mock.calls[0][0];
    expect(state.areas.length).toBeGreaterThan(1);
    expect(state.phase).toBe('playing');
    mode.destroy();
  });

  it('advances the background game on each timer step', async () => {
    const renderer = makeRenderer();
    const mode = createTitleAttractMode({ store: createGameStore(), renderer });
    await mode.start();

    vi.advanceTimersByTime(MAX_STEP_MS);
    expect(renderer.update).toHaveBeenCalledTimes(1);
    // update(prev, next) receives two distinct engine states
    const [prev, next] = renderer.update.mock.calls[0];
    expect(prev).not.toBe(next);

    vi.advanceTimersByTime(MAX_STEP_MS);
    expect(renderer.update).toHaveBeenCalledTimes(2);
    mode.destroy();
  });

  it('stop() halts stepping', async () => {
    const renderer = makeRenderer();
    const mode = createTitleAttractMode({ store: createGameStore(), renderer });
    await mode.start();
    vi.advanceTimersByTime(MAX_STEP_MS);
    const before = renderCalls(renderer);

    mode.stop();
    vi.advanceTimersByTime(MAX_STEP_MS * 20);

    expect(mode.isRunning()).toBe(false);
    expect(renderCalls(renderer)).toBe(before);
    mode.destroy();
  });

  it('lingers on a finished round, then generates a fresh board', async () => {
    const renderer = makeRenderer();
    // Cap the round at a single action so the restart path triggers quickly.
    const mode = createTitleAttractMode({
      store: createGameStore(),
      renderer,
      maxActionsPerRound: 1,
    });
    await mode.start();
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);

    // One step reaches the cap → the board lingers (no new drawMap yet)…
    vi.advanceTimersByTime(MAX_STEP_MS);
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ROUND_RESTART_MS - 1);
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);

    // …then a fresh map is generated and drawn.
    vi.advanceTimersByTime(1);
    expect(renderer.drawMap).toHaveBeenCalledTimes(2);
    expect(renderer.drawMap.mock.calls[1][0]).not.toBe(renderer.drawMap.mock.calls[0][0]);
    mode.destroy();
  });

  it('draws a static board without stepping under reduced motion', async () => {
    const renderer = makeRenderer();
    const mode = createTitleAttractMode({
      store: createGameStore(),
      renderer,
      preferencesManager: makePrefs({ reduced: true }),
    });
    await mode.start();

    expect(renderer.drawMap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MAX_STEP_MS * 20);
    expect(renderer.update).not.toHaveBeenCalled();
    mode.destroy();
  });

  it('no-ops without a renderer or with an uninitialized one', async () => {
    const store = createGameStore();
    const noRenderer = createTitleAttractMode({ store, renderer: null });
    await noRenderer.start();
    expect(noRenderer.isRunning()).toBe(false);

    const uninit = createTitleAttractMode({ store, renderer: { initialized: false } });
    await uninit.start();
    expect(uninit.isRunning()).toBe(false);
    noRenderer.destroy();
    uninit.destroy();
  });

  it('attach() runs the mode exactly while an attract screen is up', async () => {
    const renderer = makeRenderer();
    const store = createGameStore(); // initial screen: 'title'
    const mode = createTitleAttractMode({ store, renderer });

    mode.attach();
    // `running` flips synchronously; the board draw lands after the async bot
    // load, so wait on the draw itself.
    await vi.waitFor(() => expect(renderer.drawMap).toHaveBeenCalledTimes(1));
    expect(mode.isRunning()).toBe(true);

    // The bot-hub screens share the backdrop: hopping between them keeps the
    // SAME board running — no stop, no fresh drawMap.
    for (const screen of ['arena', 'tournament', 'onlineLeaderboard']) {
      store.setState({ screen });
      expect(mode.isRunning()).toBe(true);
    }
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);

    // Leaving for a game screen stops the background game…
    store.setState({ screen: 'playing' });
    expect(mode.isRunning()).toBe(false);
    const before = renderCalls(renderer);
    vi.advanceTimersByTime(MAX_STEP_MS * 5);
    expect(renderCalls(renderer)).toBe(before);

    // …and returning to an attract screen restarts it with a fresh board.
    store.setState({ screen: 'title' });
    await vi.waitFor(() => expect(renderer.drawMap).toHaveBeenCalledTimes(2));
    expect(mode.isRunning()).toBe(true);

    mode.destroy();
    expect(mode.isRunning()).toBe(false);
  });

  it('restarts the attract board when the player backs out of the map preview (#180)', async () => {
    const renderer = makeRenderer();
    const store = createGameStore(); // initial screen: 'title'
    const mode = createTitleAttractMode({ store, renderer });

    mode.attach();
    await vi.waitFor(() => expect(renderer.drawMap).toHaveBeenCalledTimes(1));

    // START hands the canvas to the real game's preview board…
    store.setState({ screen: 'mapPreview' });
    expect(mode.isRunning()).toBe(false);

    // …and backing out redraws the attract board over it — no renderer cleanup
    // needed on the way back.
    store.setState({ screen: 'title' });
    await vi.waitFor(() => expect(renderer.drawMap).toHaveBeenCalledTimes(2));
    expect(mode.isRunning()).toBe(true);

    mode.destroy();
  });

  it('start() while already running is a no-op (no duplicate boards)', async () => {
    const renderer = makeRenderer();
    const mode = createTitleAttractMode({ store: createGameStore(), renderer });
    await mode.start();
    await mode.start();
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);
    mode.destroy();
  });

  it('ends the turn (and keeps stepping) when a bot yields no move', async () => {
    const renderer = makeRenderer();
    // A legacy-style bot that returns 0 = "end turn"; injected via the loader.
    const mode = createTitleAttractMode({
      store: createGameStore(),
      renderer,
      botLoader: async () => [() => 0],
    });
    await mode.start();

    expect(() => vi.advanceTimersByTime(MAX_STEP_MS)).not.toThrow();
    // The no-move fell through to END_TURN and still advanced+rendered a new state.
    expect(renderer.update).toHaveBeenCalledTimes(1);
    const [prev, next] = renderer.update.mock.calls[0];
    expect(prev).not.toBe(next);
    expect(mode.isRunning()).toBe(true);
    mode.destroy();
  });

  it('survives a bot that throws (degrades to end turn, loop stays healthy)', async () => {
    const renderer = makeRenderer();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mode = createTitleAttractMode({
      store: createGameStore(),
      renderer,
      botLoader: async () => [
        () => {
          throw new TypeError('boom');
        },
      ],
    });
    await mode.start();

    expect(() => vi.advanceTimersByTime(MAX_STEP_MS)).not.toThrow();
    expect(renderer.update).toHaveBeenCalledTimes(1); // END_TURN fallthrough still renders
    expect(mode.isRunning()).toBe(true);
    errSpy.mockRestore();
    mode.destroy();
  });

  it('regenerates the board when a render update throws (no dead-but-running freeze)', async () => {
    const renderer = makeRenderer();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Throw on the first update only, then recover.
    renderer.update.mockImplementationOnce(() => {
      throw new Error('render boom');
    });
    const mode = createTitleAttractMode({ store: createGameStore(), renderer });
    await mode.start();
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);

    // The failing update drops the board and schedules a restart (no crash)…
    expect(() => vi.advanceTimersByTime(MAX_STEP_MS)).not.toThrow();
    expect(renderer.drawMap).toHaveBeenCalledTimes(1); // …board lingers…
    vi.advanceTimersByTime(ROUND_RESTART_MS);
    expect(renderer.drawMap).toHaveBeenCalledTimes(2); // …then a fresh board is drawn
    expect(mode.isRunning()).toBe(true);
    errSpy.mockRestore();
    mode.destroy();
  });

  it('drops ticks fired before the bot cast finishes loading (no null deref)', async () => {
    const renderer = makeRenderer();
    const prefs = makePrefs();
    // Capture the prefs subscriber so we can trigger an external schedule().
    let prefsCb;
    prefs.subscribe = vi.fn(cb => {
      prefsCb = cb;
      return () => {};
    });
    const mode = createTitleAttractMode({
      store: createGameStore(),
      renderer,
      preferencesManager: prefs,
      botLoader: () => new Promise(() => {}), // never resolves: stay in the load window
    });

    mode.attach(); // `running` flips true synchronously; loadBots() is still pending
    expect(mode.isRunning()).toBe(true);

    // An external event schedules ticks while `botFns` is still null.
    prefsCb();
    expect(() => vi.advanceTimersByTime(MAX_STEP_MS * 3)).not.toThrow();
    expect(renderer.update).not.toHaveBeenCalled();
    expect(renderer.drawMap).not.toHaveBeenCalled();

    mode.destroy();
  });
});
