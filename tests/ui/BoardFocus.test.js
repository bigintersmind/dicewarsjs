// @vitest-environment jsdom
/**
 * BoardFocus tests
 *
 * The board's DOM focus target (#211): one visually hidden button per live
 * territory, inside a `role="application"` group. What this file pins is the
 * contract everything else leans on — the ids KeyboardController looks up, the
 * names a screen reader reads out, which territories Tab stops at, and the
 * promise that a button never disappears out from under the focus it holds.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { BoardFocus } from '../../src/ui/BoardFocus.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

/**
 * Own territories are [1, 3] — area 2 belongs to the opponent.
 *
 * A dense array with a live `size` on every territory, which is the shape the
 * engine really produces and the shape the real getValidMoves walks: it runs to
 * `areas.length` and skips anything with `size === 0`, and since #211 item 10
 * the names are derived from its move list. Slot 0 is the engine's unused
 * sentinel. Individual tests below still hand in object fixtures where the
 * board state is beside the point — getValidMoves returns [] for those without
 * throwing, so the names come out bare.
 */
function makeGameState(overrides = {}) {
  return {
    phase: 'playing',
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    areas: [
      { size: 0, owner: -1, dice: 0, neighborAreaIds: [] },
      { size: 5, owner: 0, dice: 3, neighborAreaIds: [2, 3], centerCell: 10 },
      { size: 5, owner: 1, dice: 2, neighborAreaIds: [1, 3], centerCell: 20 },
      { size: 5, owner: 0, dice: 1, neighborAreaIds: [1, 2], centerCell: 30 },
    ],
    players: [
      { id: 0, territoryCount: 2 },
      { id: 1, territoryCount: 1 },
    ],
    ...overrides,
  };
}

function renderBoard(stateOverrides = {}, onSelect = vi.fn()) {
  const store = createGameStore({
    screen: 'playing',
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    playerNames: ['You', 'Blitz'],
    ...stateOverrides,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(BoardFocus, { store, onSelect }), container);
  });
  return { store, onSelect };
}

const group = () => container.querySelector('[role="application"]');
const buttons = () => [...container.querySelectorAll('button')];
const button = id => container.querySelector(`#dw-area-${id}`);

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    container.remove();
    container = null;
  }
});

describe('BoardFocus — the group', () => {
  /*
   * `application` is what makes the arrows and E reach the page at all: NVDA and
   * JAWS default to browse mode, where both are the reader's own. `.sr-only`
   * clips the buttons to a pixel — the visible focus indicator is the
   * renderer's ring on the canvas.
   *
   * The keys live in the group's NAME because `application` is the role where
   * the reader stops explaining them, and every enemy territory is
   * `tabindex="-1"` — the arrows are the only route to an attack target. A
   * reader speaks the name when focus enters the group and not on the steps
   * inside it, so saying it there costs nothing per move.
   */
  it('is an sr-only application group whose name carries the keys', () => {
    renderBoard();
    expect(group()).toBeTruthy();
    expect(group().getAttribute('aria-label')).toBe(
      'Game board. Arrow keys move between territories, Enter attacks, E ends your turn'
    );
    expect(group().classList.contains('sr-only')).toBe(true);
  });

  it('renders one button per live territory, in ascending id', () => {
    renderBoard();
    expect(buttons().map(b => b.id)).toEqual(['dw-area-1', 'dw-area-2', 'dw-area-3']);
    // Inside a form-less page the default would already be "submit"; be explicit
    // anyway, since a stray <form> ancestor would then submit on Enter.
    expect(buttons().every(b => b.getAttribute('type') === 'button')).toBe(true);
  });

  /*
   * The engine's `areas` is a dense `Area[]` whose unused slots are truthy
   * sentinels with `size: 0`, so `!area` alone would let the sentinel at index 2
   * through and announce "Territory 2" for something that is not on the board.
   */
  it('renders nothing for the empty slots of a dense area array', () => {
    renderBoard({
      gameState: makeGameState({
        areas: [
          { id: 0, size: 0, owner: -1, dice: 0, neighborAreaIds: [] },
          { id: 1, size: 5, owner: 0, dice: 3, neighborAreaIds: [2] },
          { id: 2, size: 0, owner: -1, dice: 0, neighborAreaIds: [] },
          { id: 3, size: 4, owner: 1, dice: 2, neighborAreaIds: [1] },
        ],
      }),
    });
    expect(buttons().map(b => b.id)).toEqual(['dw-area-1', 'dw-area-3']);
  });

  // A spectator has no keyboard board — KeyboardController bails on the same
  // condition — and without a game there is no board at all.
  it('renders nothing without a game or without a human seat', () => {
    renderBoard({ gameState: null });
    expect(container.innerHTML).toBe('');
    act(() => render(null, container));

    renderBoard({ humanPlayerIndex: null });
    expect(container.innerHTML).toBe('');
  });
});

describe('BoardFocus — territory names', () => {
  // The state clause is part of the name on every territory that has one — the
  // fixture's area 1 has three dice and an enemy next door, so it can attack.
  // The describe below is where each clause is pinned on its own.
  it('names the human seat as theirs', () => {
    renderBoard();
    expect(button(1).textContent).toBe('Territory 1, yours, 3 dice, can attack');
  });

  it('names a bot seat by its bot name', () => {
    renderBoard();
    expect(button(2).textContent).toBe('Territory 2, owned by Blitz, 2 dice');
  });

  /*
   * Same disambiguation as the live region: the visible board tells two seats
   * running the same bot apart by color, which speech does not have, so a
   * repeated name carries its seat number — and spokenName's trailing comma is
   * what separates the owner from the dice.
   */
  it('speaks the seat number too when the lineup repeats the owning bot name', () => {
    renderBoard({
      playerNames: ['You', 'Balanced AI', 'Balanced AI'],
      gameState: makeGameState({
        turnOrder: [0, 1, 2],
        areas: {
          0: null,
          1: { owner: 0, dice: 3, neighborAreaIds: [2, 3] },
          2: { owner: 1, dice: 2, neighborAreaIds: [1, 3] },
          3: { owner: 2, dice: 4, neighborAreaIds: [1, 2] },
        },
      }),
    });
    expect(button(3).textContent).toBe('Territory 3, owned by Balanced AI, player 3, 4 dice');
  });

  it('says "1 die" rather than "1 dice" on a single-dice territory', () => {
    renderBoard();
    expect(button(3).textContent).toBe('Territory 3, yours, 1 die');
  });

  // Defensive: MapGenerator gives every live area an owner, so this honours the
  // Area typedef's "-1 = unowned" contract rather than a reachable state.
  it('names an unowned territory as unowned', () => {
    renderBoard({
      gameState: makeGameState({
        areas: {
          0: null,
          1: { owner: 0, dice: 3, neighborAreaIds: [2] },
          2: { owner: -1, dice: 1, neighborAreaIds: [1] },
        },
      }),
    });
    expect(button(2).textContent).toBe('Territory 2, unowned, 1 die');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The board's state, in the name (#211 item 10, #204)
 * ---------------------------------------------------------------------------
 *
 * The clause after the dice is the engine's own getValidMoves read out loud:
 * the same rule that gates handleTerritoryClick and paints the hints, so a
 * player who cannot see the board is told what a sighted player is shown.
 * `no enemy neighbor` is the one negative worth its words — it is #204's exact
 * case, the only reason a territory with two dice is not a source.
 */
describe('BoardFocus — the board state in the name', () => {
  /**
   * A board with every row of the table on it, for player 0:
   *   1 — 3 dice, enemy 2 next door         → a source, and the one picked below
   *   2 — the opponent's, adjacent to 1      → reachable from 1
   *   3 — a single die                       → never a source, whatever is next door
   *   4 — the opponent's, nowhere near 1     → not reachable from 1
   *   5 — 2 dice, enemy 4 next door          → a second source
   *   6 — 2 dice, hemmed in by 3             → the dead end
   */
  function makeBoard(overrides = {}) {
    return makeGameState({
      areas: [
        { size: 0, owner: -1, dice: 0, neighborAreaIds: [] },
        { size: 5, owner: 0, dice: 3, neighborAreaIds: [2, 3, 5] },
        { size: 5, owner: 1, dice: 2, neighborAreaIds: [1, 3] },
        { size: 5, owner: 0, dice: 1, neighborAreaIds: [1, 2] },
        { size: 5, owner: 1, dice: 2, neighborAreaIds: [5] },
        { size: 5, owner: 0, dice: 2, neighborAreaIds: [1, 4] },
        { size: 5, owner: 0, dice: 2, neighborAreaIds: [3] },
      ],
      ...overrides,
    });
  }

  it('marks the territories that can attack, and says why the others cannot', () => {
    renderBoard({ gameState: makeBoard() });

    expect(button(1).textContent).toBe('Territory 1, yours, 3 dice, can attack');
    expect(button(5).textContent).toBe('Territory 5, yours, 2 dice, can attack');
    expect(button(6).textContent).toBe('Territory 6, yours, 2 dice, no enemy neighbor');
    // A single die says it already — nothing to add.
    expect(button(3).textContent).toBe('Territory 3, yours, 1 die');
    // Nothing is aimed at anything yet, so an opponent's territory is just theirs.
    expect(button(2).textContent).toBe('Territory 2, owned by Blitz, 2 dice');
    expect(button(4).textContent).toBe('Territory 4, owned by Blitz, 2 dice');
  });

  it('names the selection and sorts the enemies into targets once a source is picked', () => {
    renderBoard({ gameState: makeBoard(), selectedFrom: 1 });

    expect(button(1).textContent).toBe('Territory 1, yours, 3 dice, selected');
    expect(button(2).textContent).toBe('Territory 2, owned by Blitz, 2 dice, valid target');
    expect(button(4).textContent).toBe('Territory 4, owned by Blitz, 2 dice, not a valid target');
    // The other source keeps its clause: Enter there re-picks rather than attacks.
    expect(button(5).textContent).toBe('Territory 5, yours, 2 dice, can attack');
    expect(button(3).textContent).toBe('Territory 3, yours, 1 die');
  });

  /*
   * Keyed on the selection, not on `awaitingInput`: the selection is what
   * changed the board's meaning. awaitingInput is nulled for the whole battle
   * animation while selectedFrom stands, and a name that flipped back to source
   * mode there — then to target mode again on the next click — would be two
   * extra changes under a parked focus for every attack.
   */
  it('still reads as a target board while the dice are rolling', () => {
    renderBoard({
      gameState: makeBoard(),
      selectedFrom: 1,
      awaitingInput: null,
      animationPhase: 'battle',
    });

    expect(button(1).textContent).toBe('Territory 1, yours, 3 dice, selected');
    expect(button(2).textContent).toBe('Territory 2, owned by Blitz, 2 dice, valid target');
  });

  /*
   * The AI loop sets selectedFrom for its own attack, so the guard has to be the
   * turn and not just the selection: on someone else's turn there is no move of
   * yours to describe, and every clause would be a lie about a board you cannot
   * play.
   */
  it('says nothing about the board on an AI turn', () => {
    renderBoard({
      gameState: makeBoard({ currentPlayerIndex: 1 }),
      selectedFrom: 2,
    });

    expect(button(1).textContent).toBe('Territory 1, yours, 3 dice');
    expect(button(2).textContent).toBe('Territory 2, owned by Blitz, 2 dice');
    expect(button(6).textContent).toBe('Territory 6, yours, 2 dice');
  });

  /*
   * The rule is getValidMoves, not the hint set: `boardHints` is a visual
   * preference, and turning the outlines off must not take the board's state
   * away from the player who never sees them.
   */
  it('keeps the state in the names with the board hints turned off', () => {
    renderBoard({
      gameState: makeBoard(),
      selectedFrom: 1,
      preferences: { boardHints: 'off' },
    });

    expect(button(1).textContent).toBe('Territory 1, yours, 3 dice, selected');
    expect(button(2).textContent).toBe('Territory 2, owned by Blitz, 2 dice, valid target');
    expect(button(5).textContent).toBe('Territory 5, yours, 2 dice, can attack');
  });
});

describe('BoardFocus — tab stops', () => {
  it('makes the human own territories tabbable on their turn and nothing else', () => {
    renderBoard();
    expect(button(1).getAttribute('tabindex')).toBe('0');
    expect(button(3).getAttribute('tabindex')).toBe('0');
    // Reachable by the arrows, never by Tab — standard composite-widget behaviour.
    expect(button(2).getAttribute('tabindex')).toBe('-1');
  });

  // The same condition that mounts END TURN: on an AI turn there is nothing on
  // the board for a keyboard player to do, so Tab skips it entirely.
  it('makes nothing tabbable on an AI turn', () => {
    renderBoard({ gameState: makeGameState({ currentPlayerIndex: 1 }) });
    expect(buttons().map(b => b.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);
  });

  it('reports a click as a territory selection', () => {
    const { onSelect } = renderBoard();
    act(() => button(2).click());
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});

describe('BoardFocus — focus survives a re-render', () => {
  /*
   * The reason the buttons are never unmounted on a turn change or a change of
   * owner: an element that unmounts while focused drops focus to `<body>` —
   * Chromium fires a focusout on the way out, Firefox and jsdom nothing — so
   * the ring would go stale in silence on some browsers. A `tabindex="-1"`
   * element keeps the focus it already has.
   */
  it('keeps DOM focus on a territory the opponent has just taken', () => {
    const { store } = renderBoard();
    const el = button(3);
    el.focus();
    expect(document.activeElement).toBe(el);

    act(() =>
      store.setState({
        gameState: makeGameState({
          areas: {
            0: null,
            1: { owner: 0, dice: 3, neighborAreaIds: [2, 3], centerCell: 10 },
            2: { owner: 1, dice: 2, neighborAreaIds: [1, 3], centerCell: 20 },
            3: { owner: 1, dice: 5, neighborAreaIds: [1, 2], centerCell: 30 },
          },
        }),
      })
    );

    // Same element, still focused — and now out of the Tab order, with the name
    // rewritten in place rather than remounted.
    expect(button(3)).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(el.getAttribute('tabindex')).toBe('-1');
    expect(el.textContent).toBe('Territory 3, owned by Blitz, 5 dice');
  });

  it('keeps DOM focus when the turn passes to a bot', () => {
    const { store } = renderBoard();
    const el = button(1);
    el.focus();

    act(() => store.setState({ gameState: makeGameState({ currentPlayerIndex: 1 }) }));

    expect(button(1)).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(el.getAttribute('tabindex')).toBe('-1');
  });
});
