/**
 * TitleAttractMode tests
 *
 * The background AI game behind the title screen: it must draw and advance a
 * private engine game on a timer, honor reduced motion, survive a missing
 * renderer, and start/stop strictly with the title screen.
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

  it('attach() runs the mode exactly while the screen is "title"', async () => {
    const renderer = makeRenderer();
    const store = createGameStore(); // initial screen: 'title'
    const mode = createTitleAttractMode({ store, renderer });

    mode.attach();
    // `running` flips synchronously; the board draw lands after the async bot
    // load, so wait on the draw itself.
    await vi.waitFor(() => expect(renderer.drawMap).toHaveBeenCalledTimes(1));
    expect(mode.isRunning()).toBe(true);

    // Leaving the title screen stops the background game…
    store.setState({ screen: 'arena' });
    expect(mode.isRunning()).toBe(false);
    const before = renderCalls(renderer);
    vi.advanceTimersByTime(MAX_STEP_MS * 5);
    expect(renderCalls(renderer)).toBe(before);

    // …and returning restarts it with a fresh board.
    store.setState({ screen: 'title' });
    await vi.waitFor(() => expect(renderer.drawMap).toHaveBeenCalledTimes(2));
    expect(mode.isRunning()).toBe(true);

    mode.destroy();
    expect(mode.isRunning()).toBe(false);
  });

  it('start() while already running is a no-op (no duplicate boards)', async () => {
    const renderer = makeRenderer();
    const mode = createTitleAttractMode({ store: createGameStore(), renderer });
    await mode.start();
    await mode.start();
    expect(renderer.drawMap).toHaveBeenCalledTimes(1);
    mode.destroy();
  });
});
