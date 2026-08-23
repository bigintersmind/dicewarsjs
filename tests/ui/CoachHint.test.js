// @vitest-environment jsdom
/**
 * CoachHint tests
 *
 * The contextual rules coaching shown to the human player. What matters is that
 * every number in the copy is the engine's — the dice you are about to roll,
 * the totals you just rolled, the reinforcement the END TURN rule will actually
 * pay — so these tests drive it from real engine shapes (and one real
 * `createGame` board) rather than from hard-coded strings.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { CoachHint } from '../../src/ui/CoachHint.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { createGame, calculateReinforcements } from '../../src/engine/index.js';

let container;

/**
 * A small board in the engine's own `areas` shape, played by human seat 0:
 *
 *   1 (you, 3 dice) — 2 (enemy, 2)     5 (you, 3 dice) — 3 (you, 1 die)
 *   3 (you, 1 die)  — 4 (enemy, 4)
 *
 * So: exactly one legal attack (1 → 2); area 3 can't attack (single die);
 * area 5 borders none of the enemy; and your largest connected group is
 * {1, 3, 5} = 3.
 */
function makeAreas(overrides = {}) {
  const areas = [
    null,
    { size: 4, owner: 0, dice: 3, neighborAreaIds: [2, 3] },
    { size: 4, owner: 1, dice: 2, neighborAreaIds: [1, 4] },
    { size: 4, owner: 0, dice: 1, neighborAreaIds: [1, 4, 5] },
    { size: 4, owner: 1, dice: 4, neighborAreaIds: [2, 3] },
    { size: 4, owner: 0, dice: 3, neighborAreaIds: [3] },
  ];
  for (const [id, patch] of Object.entries(overrides)) {
    areas[id] = { ...areas[id], ...patch };
  }
  return areas;
}

function makeGameState(overrides = {}) {
  const { areas, ...rest } = overrides;
  return {
    phase: 'playing',
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    winner: null,
    areas: areas ?? makeAreas(),
    players: [
      { id: 0, territoryCount: 3, eliminated: false, stock: 0 },
      { id: 1, territoryCount: 2, eliminated: false, stock: 0 },
    ],
    ...rest,
  };
}

function renderCoach(stateOverrides = {}, { onHide } = {}) {
  const store = createGameStore({
    screen: 'playing',
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    awaitingInput: 'selectFrom',
    ...stateOverrides,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(CoachHint, { store, onHide }), container);
  });
  return { store };
}

const strip = () => container.querySelector('.dw-coach');
const text = () => (strip() ? strip().textContent : '');
const headline = () => container.querySelector('.dw-coach-line')?.textContent;
const detail = () => container.querySelector('.dw-coach-detail')?.textContent;
const payout = () => container.querySelector('.dw-coach-foot')?.textContent;

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('CoachHint — picking an attacker', () => {
  it('states the two-dice rule and why a single die cannot attack', () => {
    renderCoach();
    expect(headline()).toBe('Pick one of your territories with 2 or more dice.');
    expect(detail()).toBe("Territories with a single die can't attack.");
  });

  it('points at END TURN when the board offers no attack at all', () => {
    // Drop the one attacker to a single die: nothing on the board can move.
    renderCoach({ gameState: makeGameState({ areas: makeAreas({ 1: { dice: 1 } }) }) });
    expect(headline()).toBe('No attacks available — end your turn to collect reinforcements.');
    expect(detail()).toBeUndefined();
  });
});

describe('CoachHint — picking a target', () => {
  it('names the dice the selected territory will roll, and the tie rule', () => {
    renderCoach({ awaitingInput: 'selectTo', selectedFrom: 1 });
    expect(headline()).toBe('Now pick an adjacent enemy.');
    // Area 1 holds 3 dice — the copy must read the board, not a constant.
    expect(detail()).toBe(
      "You'll roll 3 dice vs theirs — higher total wins, ties go to the defender."
    );
  });

  it('tracks the selected territory rather than repeating one dice count', () => {
    renderCoach({
      awaitingInput: 'selectTo',
      selectedFrom: 1,
      gameState: makeGameState({ areas: makeAreas({ 1: { dice: 7 } }) }),
    });
    expect(detail()).toContain("You'll roll 7 dice");
  });

  it('says so when the chosen territory has no enemy neighbor, and suggests another', () => {
    // Area 5 has 3 dice but touches only your own area 3.
    renderCoach({ awaitingInput: 'selectTo', selectedFrom: 5 });
    expect(headline()).toBe('That territory has no enemy neighbor to attack.');
    expect(detail()).toContain('Pick another one of yours');
  });
});

describe('CoachHint — after a battle', () => {
  const won = { attackerRoll: { total: 18 }, defenderRoll: { total: 11 }, success: true };
  const lost = { attackerRoll: { total: 9 }, defenderRoll: { total: 14 }, success: false };

  it('recaps a win with the totals that were actually rolled', () => {
    renderCoach({ awaitingInput: null, battleResult: won, animationPhase: 'battle' });
    expect(headline()).toBe('Won 18 vs 11 — territory captured.');
    expect(detail()).toBe('All but one die moved in.');
  });

  it('recaps a loss and says what it cost', () => {
    renderCoach({ awaitingInput: null, battleResult: lost, animationPhase: 'battle' });
    expect(headline()).toBe('Lost 9 vs 14 — your attacker is down to 1 die.');
    expect(detail()).toBe('The defender keeps everything.');
  });

  it('holds the recap after the animation clears battleResult, until the next selection', () => {
    const { store } = renderCoach({
      awaitingInput: null,
      battleResult: won,
      animationPhase: 'battle',
    });

    // The controller clears battleResult and re-arms input the moment the dice
    // animation ends — far too soon to have read a sentence.
    act(() => {
      store.setState({ battleResult: null, animationPhase: 'idle', awaitingInput: 'selectFrom' });
    });
    expect(headline()).toBe('Won 18 vs 11 — territory captured.');

    // Picking the next attacker is the player moving on: back to the prompt.
    act(() => store.setState({ awaitingInput: 'selectTo', selectedFrom: 1 }));
    expect(headline()).toBe('Now pick an adjacent enemy.');
  });

  it('does not latch an opponent battle (the strip is not even shown on their turn)', () => {
    const { store } = renderCoach({ awaitingInput: 'selectFrom' });
    act(() => {
      store.setState({
        gameState: makeGameState({ currentPlayerIndex: 1 }),
        battleResult: lost,
        awaitingInput: null,
      });
    });
    expect(strip()).toBeNull();

    // ...and it is gone again when the human's turn comes back around.
    act(() => {
      store.setState({
        gameState: makeGameState({ currentPlayerIndex: 0 }),
        battleResult: null,
        awaitingInput: 'selectFrom',
      });
    });
    expect(headline()).toBe('Pick one of your territories with 2 or more dice.');
  });
});

describe('CoachHint — the END TURN payout', () => {
  it('reports the size of the largest connected group, not the territory count', () => {
    // You own 3 territories; {1, 3, 5} are connected, so the payout is 3.
    renderCoach();
    expect(payout()).toContain('END TURN gives you 3 new dice');
    expect(payout()).toContain('largest connected group');
    expect(payout()).toContain('Max 8 per territory');
  });

  it('follows the board as it changes', () => {
    const { store } = renderCoach();
    // Capture area 2: it joins the group, which is now {1, 2, 3, 5}.
    act(() => {
      store.setState({
        gameState: makeGameState({ areas: makeAreas({ 2: { owner: 0, dice: 2 } }) }),
      });
    });
    expect(payout()).toContain('END TURN gives you 4 new dice');
  });

  it('agrees with the engine on a real generated board', () => {
    const gameState = createGame({ playerCount: 3, mapWidth: 20, mapHeight: 24, maxAreas: 20 });
    const seat = gameState.turnOrder[gameState.currentPlayerIndex];
    renderCoach({ gameState, humanPlayerIndex: seat });
    const expected = calculateReinforcements(gameState, seat);
    expect(expected).toBeGreaterThan(0);
    expect(payout()).toContain(`END TURN gives you ${expected} new dice`);
  });

  it('says "die", not "dice", for a payout of one', () => {
    // A single isolated territory: largest connected group of 1.
    const areas = [null, { size: 4, owner: 0, dice: 3, neighborAreaIds: [2] }, { size: 4, owner: 1, dice: 2, neighborAreaIds: [1] }]; // prettier-ignore
    renderCoach({
      gameState: makeGameState({
        areas,
        players: [
          { id: 0, territoryCount: 1, eliminated: false, stock: 0 },
          { id: 1, territoryCount: 1, eliminated: false, stock: 0 },
        ],
      }),
    });
    expect(payout()).toContain('END TURN gives you 1 new die');
  });
});

describe('CoachHint — when it stays out of the way', () => {
  it('renders nothing when the coaching preference is off', () => {
    renderCoach({ preferences: { coachHints: 'off' } });
    expect(strip()).toBeNull();
  });

  it('renders nothing in spectator mode (nobody to coach)', () => {
    renderCoach({ humanPlayerIndex: null });
    expect(strip()).toBeNull();
  });

  it('renders nothing on an opponent turn', () => {
    renderCoach({ gameState: makeGameState({ currentPlayerIndex: 1 }), awaitingInput: null });
    expect(strip()).toBeNull();
  });

  it('renders nothing with no game in progress', () => {
    renderCoach({ gameState: null });
    expect(strip()).toBeNull();
  });

  it('survives a state whose areas the engine cannot be asked about', () => {
    // GameOverlay-style fixtures (and a board mid-teardown) carry no areas
    // array: fall back to the generic prompt instead of throwing.
    renderCoach({ gameState: { ...makeGameState(), areas: undefined } });
    expect(headline()).toBe('Pick one of your territories with 2 or more dice.');
    expect(payout()).toBeUndefined();
  });
});

describe('CoachHint — dismissal and announcements', () => {
  it('offers a Hide hints control that reports the click', () => {
    const onHide = vi.fn();
    renderCoach({}, { onHide });
    const btn = container.querySelector('.dw-coach-hide');
    expect(btn.getAttribute('aria-label')).toBe('Hide hints');
    act(() => btn.click());
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('offers no dismiss control when no handler is wired', () => {
    renderCoach();
    expect(container.querySelector('.dw-coach-hide')).toBeNull();
  });

  it('announces the prompt politely', () => {
    renderCoach();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live.textContent).toContain('Pick one of your territories');
    expect(live.getAttribute('aria-hidden')).toBeNull();
  });

  it('mutes the live region for a battle recap, which the announcer already speaks', () => {
    renderCoach({
      awaitingInput: null,
      battleResult: { attackerRoll: { total: 18 }, defenderRoll: { total: 11 }, success: true },
    });
    const live = container.querySelector('[aria-live="polite"]');
    expect(live.getAttribute('aria-hidden')).toBe('true');
    // Still visible on screen, just not announced twice.
    expect(text()).toContain('Won 18 vs 11');
  });
});
