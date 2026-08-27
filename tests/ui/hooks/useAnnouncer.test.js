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
    expect(el.getAttribute('role')).toBe('log');
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

  it('announces "Select a neighboring territory" on selectTo', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectTo',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Select a neighboring territory');
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
   * Board keyboard focus (#211)
   * -------------------------------------------------------------------------
   *
   * The first territory after a null ring carries a "Board." prefix: focus has just come back from
   * a real control (or arrived there for the first time), and the blur to `<body>` is narrated
   * as leaving for the document. A step from one territory to the next has no prefix.
   */

  // Focus is moved after mount in these, the way KeyboardController moves it: a Tab or arrow
  // writes focusedAreaId and nothing else.
  function startPlaying(extra = {}) {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState(),
      ...extra,
    });
    return renderAnnouncer(store);
  }

  it('announces a focused territory the human owns as theirs', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 1 }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');
  });

  it('announces a focused territory a bot owns by that bot name', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 2 }));
    expect(getText()).toBe('Board. Territory 2, owned by Blitz, 2 dice.');
  });

  // Same disambiguation as the turn announcements: a repeated name carries its seat number, and
  // spokenName's trailing comma is what separates the owner from the dice.
  it('speaks the seat number too when the lineup repeats the owning bot name', () => {
    const { getText } = startPlaying({
      playerNames: ['You', 'Balanced AI', 'Balanced AI'],
      gameState: makeGameState({
        turnOrder: [0, 1, 2],
        areas: {
          0: null,
          1: { owner: 0, dice: 3, neighborAreaIds: [2, 3] },
          2: { owner: 1, dice: 2, neighborAreaIds: [1, 3] },
          3: { owner: 2, dice: 1, neighborAreaIds: [1, 2] },
        },
        players: [
          { id: 0, alive: true, territoryCount: 2 },
          { id: 1, alive: true, territoryCount: 1 },
          { id: 2, alive: true, territoryCount: 1 },
        ],
      }),
    });

    act(() => store.setState({ focusedAreaId: 3 }));
    expect(getText()).toBe('Board. Territory 3, owned by Balanced AI, player 3, 1 die.');
  });

  it('says "1 die" rather than "1 dice" on a single-dice territory', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 3 }));
    expect(getText()).toBe('Board. Territory 3, yours, 1 die.');
  });

  // A move within the board is already in context: no prefix, only the territory.
  it('re-announces as focus moves from one territory to the next', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 1 }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');

    act(() => store.setState({ focusedAreaId: 3 }));
    expect(getText()).toBe('Territory 3, yours, 1 die.');
  });

  // Emptying the region is silent (removals are not announced), and the control focus actually
  // landed on — END TURN, RULES, the settings die — is named by the screen reader itself. What is
  // avoided is a browse-mode reader finding last turn's territory sitting in the region.
  it('clears the region when focus leaves the board', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 1 }));
    act(() => store.setState({ focusedAreaId: null }));
    expect(getText()).toBe('');
  });

  // The #211 return seam: both ways back onto the board re-enter on the territory the player tabbed
  // off. The clear in the middle is what makes that a DOM change at all — writing the identical
  // string straight over itself would mutate nothing, and the reader would hear silence.
  it('speaks the territory again when focus returns to the one it left', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 3 }));
    expect(getText()).toBe('Board. Territory 3, yours, 1 die.');

    act(() => store.setState({ focusedAreaId: null }));
    expect(getText()).toBe('');

    act(() => store.setState({ focusedAreaId: 3 }));
    expect(getText()).toBe('Board. Territory 3, yours, 1 die.');
  });

  it('says nothing new when the focused id has no territory behind it', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 1 }));
    act(() => store.setState({ focusedAreaId: 99 }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');
  });

  // The engine's areas are a dense Area[] whose unused slot 0 is a truthy sentinel, so `size === 0`
  // is the guard that rejects it — `!area` alone would let it through and speak "Territory 0".
  it('says nothing for the empty slot of a dense area array', () => {
    const { getText } = startPlaying({
      gameState: makeGameState({
        areas: {
          0: { id: 0, size: 0, owner: -1, dice: 0, neighborAreaIds: [] },
          1: { id: 1, size: 5, owner: 0, dice: 3, neighborAreaIds: [2, 3] },
          2: { id: 2, size: 4, owner: 1, dice: 2, neighborAreaIds: [1, 3] },
          3: { id: 3, size: 3, owner: 0, dice: 1, neighborAreaIds: [1, 2] },
        },
      }),
    });
    const before = getText();

    act(() => store.setState({ focusedAreaId: 0 }));
    expect(getText()).toBe(before);
  });

  // `gameState` is not a dep of the focus effect — it is read from the closure — so a board that
  // changes under a standing ring cannot re-fire it over a battle result the player still needs.
  it('does not talk over a battle result when the board changes under the focus', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 1 }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');

    act(() =>
      store.setState({
        battleResult: {
          success: true,
          attackerRoll: { values: [3, 4], total: 7 },
          defenderRoll: { values: [2, 1], total: 3 },
        },
      })
    );
    expect(getText()).toContain('Attack:');

    act(() =>
      store.setState({
        gameState: makeGameState({
          areas: {
            0: null,
            1: { owner: 0, dice: 4, neighborAreaIds: [2, 3] },
            2: { owner: 1, dice: 1, neighborAreaIds: [1, 3] },
            3: { owner: 0, dice: 1, neighborAreaIds: [1, 2] },
          },
        }),
      })
    );
    expect(getText()).toContain('Attack:');
  });

  // App renders the announcer inside each screen's branch under `key={screen}`, so it remounts on
  // playing → gameOver and every effect runs afresh — over a ring nothing cleared (#211 item 3).
  // The closing line has to survive that.
  it('keeps the game-over line when the announcer remounts over a stale ring', () => {
    const { getText } = startPlaying({
      screen: 'gameOver',
      awaitingInput: null,
      gameState: makeGameState({ winner: 0 }),
      focusedAreaId: 1,
    });

    expect(getText()).toBe('Game over. You win!');
  });

  // The contract for whoever writes the next non-null focusedAreaId — #211 item 3's turn-boundary
  // reset first among them. Effects flush in declaration order and the focus effect is declared
  // first on purpose, so the turn is what the player hears.
  it('announces the turn, not the ring, when one commit changes both', () => {
    // At mount, with both already set …
    const { getText } = startPlaying({ focusedAreaId: 1 });
    expect(getText()).toMatch(/^Your turn/);

    // … and in a genuine update: the ring moves and the phase changes in the same write.
    act(() => store.setState({ focusedAreaId: 3, awaitingInput: 'selectTo' }));
    expect(getText()).toBe('Select a neighboring territory to attack.');
  });

  // The mirror of that: a turn change while the ring is standing must still be announced. Merging
  // the two effects, or short-circuiting the turn effect on a set ring, would silence whose-turn
  // for exactly the players who navigate by keyboard.
  it('still announces the turn change while the board holds focus', () => {
    const { getText } = startPlaying();

    act(() => store.setState({ focusedAreaId: 1 }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');

    act(() =>
      store.setState({
        awaitingInput: null,
        gameState: makeGameState({ currentPlayerIndex: 1 }),
      })
    );
    expect(getText()).toBe('Blitz is thinking.');
  });

  // A spectator cannot acquire a ring (KeyboardController bails on the null seat) but can inherit
  // one: startSpectate hands the seat to a bot and leaves both the id and the names alone, so the
  // seat that was the viewer's is still recorded as "You".
  it('says nothing for a ring a spectator inherited', () => {
    const spectating = startPlaying({
      humanPlayerIndex: null,
      awaitingInput: null,
      focusedAreaId: 1,
    });
    expect(spectating.getText()).toBe('');

    // Torn down by hand: a second renderAnnouncer() would replace the module-level container and
    // leave this one mounted for the rest of the file.
    act(() => render(null, container));
    container.remove();
    container = null;
    store = createGameStore();

    const { getText } = startPlaying();
    act(() => store.setState({ focusedAreaId: 1 }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');

    // startSpectate's payload minus the screen it also sets. Through App that screen change
    // (gameOver → playing) remounts the announcer, so this write never reaches a mounted one today;
    // it pins the effect's own contract for when #211 item 9 stops the remount.
    act(() => store.setState({ humanPlayerIndex: null, awaitingInput: null }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');
    expect(getText()).not.toContain('owned by You');
  });

  // A name reset is not a focus move. With `playerNames` in the focus effect's deps, this re-spoke
  // the standing territory as "owned by Player 2" under the announcer rendered standalone; through
  // App the lineup is only rewritten off the playing screen (goToTitle, startNewGame), where the
  // per-screen remount hides it today — this pins the contract for when #211 item 9 stops that.
  it('does not re-speak the ring when the lineup is reset under it', () => {
    // Mid-animation on the human's own turn, so the turn effect writes nothing of its own.
    const { getText } = startPlaying({ awaitingInput: null });

    act(() => store.setState({ focusedAreaId: 2 }));
    expect(getText()).toBe('Board. Territory 2, owned by Blitz, 2 dice.');

    act(() => store.setState({ playerNames: [] }));
    expect(getText()).toBe('Board. Territory 2, owned by Blitz, 2 dice.');
  });

  // goToTitle nulls the ring and leaves the playing screen in one write. Today that write also
  // unmounts the announcer (App keys it per screen); once #211 item 9 hoists it, the ref behind
  // the "Board." prefix has to see the null even though the effect says nothing off-screen, or
  // the next game's first Tab would arrive as a bare territory.
  it('re-arms the entry prefix when the ring is nulled on the way to the title', () => {
    const { getText } = startPlaying();
    act(() => store.setState({ focusedAreaId: 3 }));
    expect(getText()).toBe('Board. Territory 3, yours, 1 die.');

    // goToTitle's payload, reduced to the fields this hook reads.
    act(() =>
      store.setState({
        screen: 'title',
        gameState: null,
        awaitingInput: null,
        focusedAreaId: null,
        playerNames: [],
      })
    );
    // Off the playing screen it says nothing and clears nothing.
    expect(getText()).toBe('Board. Territory 3, yours, 1 die.');

    // The next game on the same mount, mid-animation so the turn effect stays quiet.
    act(() =>
      store.setState({
        screen: 'playing',
        gameState: makeGameState(),
        awaitingInput: null,
        playerNames: ['You', 'Blitz'],
      })
    );
    act(() => store.setState({ focusedAreaId: 1 }));
    expect(getText()).toBe('Board. Territory 1, yours, 3 dice.');
  });
});
