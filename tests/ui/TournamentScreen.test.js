// @vitest-environment jsdom
/**
 * TournamentScreen tests (#92 item 2).
 *
 * TournamentScreen is a third, independently-wired consumer of the broken-bot flag signal:
 * it maps a tournament result's `standings` to leaderboard rows and threads
 * `flagged={result.flagged}` into <Leaderboard>. Dropping that prop — the exact copy-paste
 * omission #92 guards against — would ship a broken bot with no badge and no test would fail.
 * ArenaScreen has this test; this closes the asymmetry by driving the screen with a mocked
 * runRoundRobin that returns a flagged bot and asserting the badge lands on its row.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { TournamentScreen } from '../../src/ui/TournamentScreen.jsx';
import * as tournament from '../../src/arena/tournament.js';

let container;

function renderTournament(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(TournamentScreen, props), container));
}

const button = text => [...container.querySelectorAll('button')].find(b => b.textContent === text);
const row = name =>
  [...container.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes(name));

/** A round-robin standing row in the shape TournamentScreen maps to leaderboard rows. */
function standing(name, over = {}) {
  return {
    name,
    wins: 3,
    losses: 3,
    gamesPlayed: 6,
    elo: 1200,
    points: 9,
    errors: 0,
    invalidMoves: 0,
    maxMovesHit: 0,
    ...over,
  };
}

/** Round-robin is the default tournamentType, so handleRun calls runRoundRobin. */
function mockRoundRobin(resultOver) {
  return vi.spyOn(tournament, 'runRoundRobin').mockReturnValue({
    type: 'round-robin',
    rounds: [],
    totalGames: 6,
    failedGames: 0,
    ...resultOver,
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

describe('TournamentScreen broken-bot surfacing', () => {
  it('threads result.flagged into the leaderboard so the broken row gets a badge', async () => {
    vi.useFakeTimers();
    mockRoundRobin({
      standings: [
        standing('Healthy', { elo: 1350, wins: 6, losses: 0, points: 18 }),
        standing('Broken', { elo: 900, wins: 0, losses: 6, points: 0, errors: 30 }),
      ],
      flagged: [
        {
          name: 'Broken',
          errors: 30,
          attacks: 0,
          invalidMoves: 0,
          maxMovesHit: 0,
          errorFraction: 1,
        },
      ],
      champion: 'Healthy',
    });

    renderTournament();
    act(() => button('START TOURNAMENT').click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const broken = row('Broken');
    expect(broken).toBeTruthy();
    expect(broken.textContent).toContain('⚠');
    expect(broken.textContent).toContain('30 error turns');

    // The healthy bot is not badged — the flag is tied to the right row, not the whole table.
    expect(row('Healthy').textContent).not.toContain('⚠');
  });

  it('renders the results table with no badge when nothing is flagged', async () => {
    vi.useFakeTimers();
    mockRoundRobin({
      standings: [
        standing('Alpha', { elo: 1300, wins: 4, losses: 2, points: 12 }),
        standing('Beta', { elo: 1150, wins: 2, losses: 4, points: 6 }),
      ],
      flagged: [],
      champion: 'Alpha',
    });

    renderTournament();
    act(() => button('START TOURNAMENT').click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(container.querySelector('table')).toBeTruthy();
    expect(container.textContent).not.toContain('⚠');
  });
});
