// @vitest-environment jsdom
/**
 * ArenaScreen tests (#92 item 3).
 *
 * ArenaScreen runs its OWN arena loop (one game per macrotask, so Preact can paint) rather
 * than calling runArena. That fork used to copy-paste the accumulate-and-report logic, so a
 * drift could let a broken bot show a meaningless rating with no test catching it. The loop
 * now delegates to the shared arenaAccumulator helpers; this test drives the screen with a
 * mocked runMatch that returns a broken bot and asserts the warning fires AND the flag badge
 * renders — the two ends of that wiring.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ArenaScreen } from '../../src/ui/ArenaScreen.jsx';
import * as matchRunner from '../../src/arena/matchRunner.js';

let container;

function renderArena(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(ArenaScreen, props), container));
}

const button = text => [...container.querySelectorAll('button')].find(b => b.textContent === text);

/**
 * Mock a match where seat 0 is broken (errors every turn, never attacks) and the rest are
 * healthy. Reads config.bots so the returned botStats line up with whatever field the screen
 * built. Returns the seat-0 (broken) name via the captured ref.
 */
function mockBrokenMatch(brokenRef) {
  return matchRunner.runMatch.mockImplementation(({ bots }) => {
    brokenRef.name = bots[0].name;
    const botStats = bots.map((b, i) => ({
      name: b.name,
      playerIndex: i,
      finalTerritories: i === 0 ? 0 : 4,
      finalDice: 1,
      placement: i === 0 ? bots.length : i,
      attacksMade: i === 0 ? 0 : 8,
      attacksWon: i === 0 ? 0 : 4,
      errors: i === 0 ? 20 : 0,
      invalidMoves: 0,
      maxMovesHit: 0,
    }));
    return {
      winner: 1,
      winnerName: bots[1].name,
      turnCount: 10,
      placements: bots.map((_, i) => i),
      botStats,
      config: { seed: 1, playerCount: bots.length },
      finalState: {},
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('ArenaScreen broken-bot surfacing', () => {
  it('warns and badges a bot that errors on every turn when RUN ARENA is clicked', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(matchRunner, 'runMatch');
    const broken = {};
    mockBrokenMatch(broken);

    renderArena();

    // Fewest games so the mocked loop is quick and deterministic.
    act(() => button('5').click());
    act(() => button('RUN ARENA').click());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // The [Arena] error-fraction warning fired for the broken bot...
    const warned = warnSpy.mock.calls.map(c => String(c[0])).filter(m => /error fraction/.test(m));
    expect(warned.length).toBeGreaterThan(0);
    expect(warned.some(m => m.includes(broken.name))).toBe(true);

    // ...and the results table renders the flag badge for it.
    expect(container.textContent).toContain('⚠');
    expect(container.textContent).toContain('error turn');
  });

  it('shows no flag badge when every bot is healthy', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(matchRunner, 'runMatch').mockImplementation(({ bots }) => ({
      winner: 0,
      winnerName: bots[0].name,
      turnCount: 10,
      placements: bots.map((_, i) => i),
      botStats: bots.map((b, i) => ({
        name: b.name,
        playerIndex: i,
        finalTerritories: 4,
        finalDice: 2,
        placement: i + 1,
        attacksMade: 8,
        attacksWon: 4,
        errors: 0,
        invalidMoves: 0,
        maxMovesHit: 0,
      })),
      config: { seed: 1, playerCount: bots.length },
      finalState: {},
    }));

    renderArena();
    act(() => button('5').click());
    act(() => button('RUN ARENA').click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Results rendered (a leaderboard table is present) but no flag badge.
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.textContent).not.toContain('⚠');
  });
});
