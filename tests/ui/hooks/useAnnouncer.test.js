// @vitest-environment jsdom
/**
 * useAnnouncer / ScreenReaderAnnouncer tests
 *
 * Verifies that game state changes produce correct screen reader
 * announcements via the ARIA live region.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ScreenReaderAnnouncer } from '../../../src/ui/ScreenReaderAnnouncer.jsx';
import { createGameStore } from '../../../src/store/GameStore.js';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

function makeGameState(overrides = {}) {
  return {
    phase: 'playing',
    grid: { width: 28, height: 32, cellCount: 896 },
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    history: [],
    winner: null,
    areas: {
      0: null,
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

let container;

function renderAnnouncer(store) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(ScreenReaderAnnouncer, { store }), container);
  });
  return {
    getText: () => container.querySelector('[aria-live]')?.textContent || '',
    getEl: () => container.querySelector('[aria-live]'),
  };
}

afterEach(() => {
  if (container) {
    act(() => {
      render(null, container);
    });
    if (container.parentNode) {
      document.body.removeChild(container);
    }
    container = null;
  }
});

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe('ScreenReaderAnnouncer', () => {
  let store;

  beforeEach(() => {
    store = createGameStore();
  });

  it('renders with correct ARIA attributes', () => {
    const { getEl } = renderAnnouncer(store);
    const el = getEl();
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    // Not "log": one line replaced in place is advisory status, not an
    // append-only history of lines (#211 item 11). The explicit aria-live /
    // aria-atomic above pin the behaviour either way.
    expect(el.getAttribute('role')).toBe('status');
  });

  it('shows no announcement when game state is null', () => {
    store.setState({
      screen: 'playing',
      gameState: null,
      humanPlayerIndex: 0,
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('');
  });

  it('announces "Your turn" with territory count on human turn', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Your turn');
    expect(getText()).toContain('2 territories');
  });

  /*
   * The prompt names the arrow keys because this is the moment a screen-reader
   * player has nothing else: every enemy territory is `tabindex="-1"`, so Tab
   * reaches no attack target at all.
   */
  it('announces the selectTo prompt with the arrow keys that reach a target', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectTo',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('Select a neighboring territory to attack. Use the arrow keys to move.');
  });

  it('announces the AI by its bot name on a non-human turn', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Blitz is thinking');
    expect(getText()).not.toContain('Player 2');
  });

  it('falls back to the seat number when no player names are recorded', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: [],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Player 2 is thinking');
  });

  // Names are indexed by seat (turnOrder[currentPlayerIndex]), not by turn slot — real games
  // shuffle turnOrder, and the identity-order fixture above cannot tell the two apart.
  it('names the seat whose turn it is under a shuffled turn order', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ turnOrder: [1, 0], currentPlayerIndex: 0 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Blitz is thinking');
  });

  // A live region has no color to tell two seats running the same bot apart (the visual
  // label's disambiguator), so a repeated name is spoken with its seat number — the whole
  // Standard lineup is Balanced AI. A unique name is spoken bare (see the Blitz cases).
  it('speaks the seat number too when the lineup repeats the bot name', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Balanced AI', 'Balanced AI'],
      gameState: makeGameState({
        turnOrder: [0, 1, 2],
        currentPlayerIndex: 2,
        players: [
          { id: 0, alive: true, territoryCount: 2 },
          { id: 1, alive: true, territoryCount: 1 },
          { id: 2, alive: true, territoryCount: 1 },
        ],
      }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Balanced AI, player 3, is thinking.');
  });

  // The effect must re-run on a lineup change alone: two back-to-back games can agree on
  // every other dependency (screen, turn index, human seat, winner, phase) and differ only in
  // who sits where — without `playerNames` in the deps the old game's bot would be announced.
  it('re-announces when the lineup changes under the same turn state', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Blitz is thinking');

    act(() => store.setState({ playerNames: ['You', 'Conqueror'] }));
    expect(getText()).toContain('Conqueror is thinking');
  });

  it('announces a human win as "You win!"', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ winner: 0 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Game over. You win!');
  });

  it('announces a bot win by its bot name', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ winner: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Game over. Blitz wins!');
  });

  it('announces a bot win with its seat number when the lineup repeats the name', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Balanced AI', 'Balanced AI'],
      gameState: makeGameState({ winner: 2 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Game over. Balanced AI, player 3, wins!');
  });

  it('announces battle result', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
      battleResult: {
        success: true,
        attackerRoll: { values: [3, 4], total: 7 },
        defenderRoll: { values: [2, 1], total: 3 },
      },
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('7');
    expect(getText()).toContain('3');
    expect(getText()).toContain('Success');
  });

  it('updates announcement reactively when store changes', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Your turn');

    // Transition to game over
    act(() => {
      store.setState({
        screen: 'gameOver',
        gameState: makeGameState({ winner: 0 }),
      });
    });

    expect(getText()).toContain('Game over');
  });

  /*
   * -------------------------------------------------------------------------
   * The region is mounted on every screen (#211 item 9)
   *
   * App used to render the announcer inside the `playing` and `gameOver`
   * branches of its screen switch, so the hook only ever ran over a live game
   * and could read the store without asking which screen was up. It now lives
   * outside the switch — one node, mounted for the whole session, because a
   * live region that appears already populated is frequently not announced at
   * all. That hands the hook two new jobs: say nothing on the screens that are
   * not a game, and clear itself on the way out so the next game's identical
   * line is a change the assistive tech can see.
   * -------------------------------------------------------------------------
   */

  it('says nothing over the map preview, where the first seat may be a bot', () => {
    /* The exact shape the controller leaves behind at mapPreview: a complete
       fresh gameState, awaitingInput null, and a turn order that can open on a
       bot — which is the "is thinking" branch's own precondition. Nobody is
       playing yet, so nobody is thinking out loud. */
    store.setState({
      screen: 'mapPreview',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('');
  });

  /*
   * SPECTATE from the game-over card puts the screen back on 'playing' and
   * nulls the human seat, and none of the branches below the guards match without one
   * — so whatever the last line was would sit in the region for the whole
   * spectated game. The region used to be remounted by App's screen switch,
   * which cleared it as a side effect; since #211 item 9 it is one node for the
   * session and the hook has to do it itself.
   */
  it('clears the line when the seat goes away (spectate)', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Blitz is thinking');

    act(() => store.setState({ humanPlayerIndex: null }));
    expect(getText()).toBe('');
  });

  /*
   * ...but the seatless guard sits BELOW the game-over branch, so a spectated
   * game still ends out loud. That line names a bot rather than a seat, so it is
   * as true for a watcher as for a player — and it was announced before the
   * guard existed, which is what makes this a pin rather than a new feature.
   */
  it('still announces the winner of a spectated game', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: null,
      playerNames: ['Conqueror', 'Blitz'],
      gameState: makeGameState({ winner: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('Game over. Blitz wins!');
  });

  it('does not speak a leftover battle result on the title screen', () => {
    /* A battle result still in the store while the screen is not a game screen.
       No path arranges that today — goToTitle nulls battleResult in the same
       setState that changes the screen — so this is the guard held to rather
       than a leftover anyone can produce. The line would be about a board that
       is no longer on screen. */
    store.setState({
      screen: 'title',
      awaitingInput: null,
      humanPlayerIndex: 0,
      gameState: makeGameState(),
      battleResult: {
        success: true,
        attackerRoll: { values: [3, 4], total: 7 },
        defenderRoll: { values: [2, 1], total: 3 },
      },
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('');
  });

  /*
   * The other half of that guard, and the reason the battle effect's deps are
   * `[battleResult]` alone: the attack that WINS the game. Were the result still
   * in the store when the screen flips — both effects live over the same store,
   * the battle effect the later of the two — then with `screen` in its deps it
   * would re-run on the flip and overwrite "Game over. You win!" with the attack
   * line that produced it. Deps of `[battleResult]` mean the closure runs only
   * on the render where the result itself changed.
   *
   * The controller nulls `battleResult` before `triggerGameOver` on both attack
   * paths, so that ordering is arranged here by hand: what this pins is the deps
   * list against an exhaustive-deps "fix", which the source comment also argues.
   * It is what makes that "fix" fail rather than ship.
   */
  it('does not let the last battle line overwrite the game-over line', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState(),
    });
    const { getText } = renderAnnouncer(store);
    act(() =>
      store.setState({
        battleResult: {
          success: true,
          attackerRoll: { values: [3, 4], total: 7 },
          defenderRoll: { values: [2, 1], total: 3 },
        },
      })
    );
    expect(getText()).toBe('Attack: rolled 7 vs 3. Success.');

    // The attack that won the game: battleResult is unchanged, only the screen flips.
    act(() =>
      store.setState({
        screen: 'gameOver',
        awaitingInput: null,
        gameState: makeGameState({ winner: 0 }),
      })
    );
    expect(getText()).toBe('Game over. You win!');
  });

  it('clears the line when a game screen is left', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ winner: 0 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('Game over. You win!');

    act(() => store.setState({ screen: 'title', gameState: null }));
    expect(getText()).toBe('');
  });

  /*
   * Why the clear matters, in the one case that motivates it: setAnnouncement
   * with the string already in state is a no-op — no re-render, no DOM
   * mutation, nothing for a screen reader to notice — so on a persistent region
   * two games ending the same way would announce the first and stay silent for
   * the second. The intermediate '' asserted below IS the contract, not an
   * incidental step: it is what makes the second line a change.
   */
  it('makes an identical game-over line a fresh announcement in the next game', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ winner: 0 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('Game over. You win!');

    act(() => store.setState({ screen: 'title', gameState: null }));
    expect(getText()).toBe('');

    act(() =>
      store.setState({
        screen: 'gameOver',
        gameState: makeGameState({ winner: 0 }),
      })
    );
    expect(getText()).toBe('Game over. You win!');
  });

  /*
   * The hoist's contract at the hook level: playing → gameOver is the
   * transition that used to remount the region (App keyed the screen boundary),
   * and it is the one the guard above must not silence. Same store, same node,
   * text replaced.
   */
  it('replaces the turn line with the game-over line on the same region', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState(),
    });

    const { getText, getEl } = renderAnnouncer(store);
    const region = getEl();
    expect(getText()).toContain('Your turn');

    act(() =>
      store.setState({
        screen: 'gameOver',
        awaitingInput: null,
        gameState: makeGameState({ winner: 0 }),
      })
    );

    expect(getEl()).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(getText()).toBe('Game over. You win!');
  });
});
