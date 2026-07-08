// @vitest-environment jsdom
/**
 * Leaderboard tests — focus on the broken-bot flag badge (#92 item 2). The flag decision
 * lives in the JS layer (reportBotErrors); this component only displays the `flagged` prop.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { Leaderboard } from '../../src/ui/Leaderboard.jsx';

let container;

function renderLeaderboard(props) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(Leaderboard, props), container));
}

function row(name) {
  return [...container.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes(name));
}

const bots = [
  { name: 'Healthy', elo: 1300, wins: 20, gamesPlayed: 40, avgPlacement: 2.1, attackWinRate: 0.55 },
  { name: 'Broken', elo: 900, wins: 0, gamesPlayed: 40, avgPlacement: 6.9, attackWinRate: 0 },
];

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('Leaderboard flag badge', () => {
  it('renders no badge when nothing is flagged', () => {
    renderLeaderboard({ bots });
    expect(container.textContent).not.toContain('⚠');
  });

  it('renders no badge when flagged is omitted entirely', () => {
    renderLeaderboard({ bots });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.textContent).not.toContain('error turn');
  });

  it('badges a flagged bot with its error-turn count and leaves healthy rows unmarked', () => {
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, errorFraction: 1 }],
    });

    const broken = row('Broken');
    expect(broken.textContent).toContain('⚠');
    expect(broken.textContent).toContain('30 error turns');

    expect(row('Healthy').textContent).not.toContain('⚠');
  });

  it('describes an invalid-move-only flag by its invalid-move count, not "0 error turns"', () => {
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 0, invalidMoves: 12, errorFraction: 1 }],
    });

    const broken = row('Broken');
    expect(broken.textContent).toContain('12 invalid moves');
    expect(broken.textContent).not.toContain('error turns');
  });

  it('gives a flagged row a distinct background so it reads as unreliable', () => {
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, errorFraction: 1 }],
    });
    // jsdom normalizes the rgba() background; just assert it differs from the unstyled row.
    expect(row('Broken').style.background).not.toBe('');
    expect(row('Healthy').style.background).toBe('');
  });
});
