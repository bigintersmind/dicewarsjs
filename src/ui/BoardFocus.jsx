/**
 * Board Focus
 *
 * The board's DOM focus target (#211 item 2). The hex grid is drawn on a canvas,
 * which holds nothing a browser or a screen reader can focus, so this component
 * renders the board a second time as real controls: one visually hidden
 * `<button>` per live territory, in ascending id, inside a `role="application"`
 * group. Everything else about board focus follows from that.
 *
 * Why real buttons rather than `aria-activedescendant` on one element: a focus
 * change onto a named button is the one event every assistive technology
 * announces (VoiceOver, NVDA, JAWS, Narrator, Orca). `aria-activedescendant` is
 * well supported on the listbox / tree / grid / combobox roles it was designed
 * for; on `role="application"` its support is uneven — VoiceOver in particular
 * has a history of ignoring it outside those roles — and the fallback would
 * have been keeping the #211 item 1 live-region effect, which is two voices
 * over one move.
 *
 * Why `role="application"`: NVDA and JAWS default to browse mode, where the
 * arrow keys move their own virtual cursor and single letters are quick-nav
 * commands — neither normally reaches a keydown listener, so the arrows and E
 * have been dead under those readers all along. `application` hands the keys to
 * the page.
 *
 * That is also why the group's NAME carries the key instructions. ARIA asks the
 * author of an `application` region to supply them, precisely because the
 * reader has stopped mediating the keys — and here they are load-bearing: every
 * territory the human does not own is `tabindex="-1"`, so under NVDA or JAWS
 * the arrows are the only way to reach an attack target. A reader speaks the
 * group's name when focus first enters it and not again on a button → button
 * move inside it, which is the one place instructions can live without being
 * read out on every step.
 *
 * Each button's NAME can carry the board's state as well as its identity, on the
 * human's turn — `can attack`, `selected`, `no enemy neighbor`, `valid target`,
 * `not a valid target` — read off the engine's own getValidMoves (#211 item 10,
 * #204). It is the same list handleTerritoryClick gates on and the same list the
 * board hints outline, so what a player is told, what a click accepts and what
 * the board shows are three readings of one rule. A sighted player has the
 * outlines for this when the hints are on; without the clause the only way to
 * find out that Enter does nothing here is to press it.
 *
 * DOM order IS the tab order: App renders this component between GameHUD and
 * GameOverlay, giving settings die → QUIT → RULES → own territories ascending →
 * END TURN (#201, #211). The browser walks it natively — nothing in the
 * controller touches Tab any more.
 *
 * `tabindex` is 0 only on the human's own territories, and only on the human's
 * turn (the same condition that mounts END TURN); everything else is -1, which
 * is reachable by the arrow keys but never by Tab — standard composite-widget
 * behaviour. The buttons themselves never unmount for a turn change or a change
 * of owner: an element that unmounts while focused drops focus to `<body>` —
 * Chromium fires a focusout on the way out, Firefox and jsdom fire nothing, so
 * nothing can be relied on to react — whereas a `tabindex="-1"` element keeps
 * the focus it already has. Territories never leave the board mid-game either;
 * what removes these buttons is the playing screen itself going away (game
 * over, spectate, quit to title), and GameController nulls `focusedAreaId` at
 * each of those seams for exactly the reason above.
 *
 * `store.focusedAreaId` mirrors DOM focus rather than driving it:
 * KeyboardController's `focusin`/`focusout` listeners write the id and paint (or
 * take down) the renderer's focus ring, so a Tab, an arrow, a click, and a
 * dialog restoring focus all reach the ring by one path. The ring is the
 * renderer's; these buttons are clipped to a pixel by `.sr-only` and are never
 * seen.
 *
 * Enter and Space are the button's own native activation — its click reaches
 * `controller.handleTerritoryClick(id)` through `onSelect`, exactly as a canvas
 * click does — so the controller no longer handles either key.
 *
 * @module ui/BoardFocus
 */

import { useGameStore } from './hooks/useGameStore.js';
import { spokenName, diceCount } from './spokenName.js';
import { areaElementId } from '../controller/KeyboardController.js';
/*
 * Straight from StateManager rather than through the engine barrel: the barrel
 * is the surface the controller's tests stub
 * (`vi.mock('../../src/engine/index.js')`), and this rule should keep answering
 * to the engine in any test that stubs it for the controller. ReplayViewer
 * already imports an engine module directly (`../engine/GameRunner.js`) — this
 * is a pure query over a state object, no different from reading `area.dice`.
 */
import { getValidMoves } from '../engine/StateManager.js';

/**
 * What the board's own rules say about this territory right now, as the last
 * clause of its name — or null when there is nothing to say (#211 item 10).
 *
 * The state goes in the TEXT rather than in an ARIA attribute because there is
 * no attribute that means it: `aria-selected` is invalid on a button,
 * `aria-pressed` is a toggle and this source cannot be un-pressed with Enter,
 * and `aria-disabled` would read as "unavailable" without saying why. The text
 * content is the accessible name, so there is nothing for it to drift from.
 *
 * `no enemy neighbor` is the one negative worth its words: it is the only
 * reason a territory with two dice is not a source, it is the rules card's
 * second condition, and it is #204 — the click accepts exactly what this
 * clause claims, because both ask getValidMoves.
 *
 * @param {number} id - Area id
 * @param {import('../engine/types.js').Area} area
 * @param {boolean} isMine - The territory belongs to the human seat
 * @param {{ selectedFrom: number | null, sources: Set<number>, targets: Set<number> } | null} board
 *   This turn's move list, folded into two sets — or null on an AI's turn, when
 *   none of it is the player's to act on.
 * @returns {string | null}
 */
function boardStateClause(id, area, isMine, board) {
  if (!board) return null;

  /*
   * Target mode is keyed on the selection, not on `awaitingInput`: picking a
   * source is what changed what every other territory MEANS, and awaitingInput
   * is null for the length of the battle animation with the selection still
   * standing. Keying on it would rewrite every name once more per attack — on
   * the `setState({ awaitingInput: null })` that opens executeAttack, a render
   * this component otherwise sits out — and would do it mid-animation, under a
   * focus the player has parked.
   */
  const targetMode = board.selectedFrom != null;

  if (isMine) {
    if (id === board.selectedFrom) return 'selected';
    // Still 'can attack' in target mode: Enter on another source re-picks it.
    if (board.sources.has(id)) return 'can attack';
    // A single die says it already; anything more is the dead end (#204).
    return area.dice > 1 ? 'no enemy neighbor' : null;
  }

  if (!targetMode) return null;
  return board.targets.has(id) ? 'valid target' : 'not a valid target';
}

/**
 * What a screen reader reads out when the territory takes focus — the button's
 * text content, so it is the accessible name with no `aria-label` to drift from
 * it. No trailing period: this is a name, not a sentence, and readers pause on
 * the commas anyway.
 *
 * The owner is spoken before the dice because spokenName brings its own
 * trailing comma on a repeated name ("Balanced AI, player 3,"), which flows
 * straight into the dice clause where a possessive could not. The board's state
 * comes last, after the two facts that identify the territory.
 *
 * @param {number} id - Area id
 * @param {import('../engine/types.js').Area} area
 * @param {number} humanPlayerIndex
 * @param {string[] | undefined} playerNames
 * @param {{ selectedFrom: number | null, sources: Set<number>, targets: Set<number> } | null} board
 * @returns {string}
 */
function areaLabel(id, area, humanPlayerIndex, playerNames, board) {
  const dice = diceCount(area.dice);

  // Defensive: MapGenerator gives every live area an owner, so this is a torn-state guard rather
  // than a state the player can reach — it honours the `Area` typedef's "-1 = unowned" contract.
  // A territory nobody owns is named and nothing more: an unowned slot is a torn state, not a
  // board position worth describing.
  if (typeof area.owner !== 'number' || area.owner < 0) {
    return `Territory ${id}, unowned, ${dice}`;
  }

  const isMine = area.owner === humanPlayerIndex;
  const state = boardStateClause(id, area, isMine, board);
  const stateClause = state ? `, ${state}` : '';

  if (isMine) return `Territory ${id}, yours, ${dice}${stateClause}`;

  const spoken = spokenName(playerNames, area.owner);
  const ownerClause = spoken.endsWith(',') ? spoken : `${spoken},`;
  return `Territory ${id}, owned by ${ownerClause} ${dice}${stateClause}`;
}

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {(areaId: number) => void} props.onSelect - Activation, same entry point as a board click
 */
export function BoardFocus({ store, onSelect }) {
  const gameState = useGameStore(store, s => s.gameState);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const playerNames = useGameStore(store, s => s.playerNames);
  const selectedFrom = useGameStore(store, s => s.selectedFrom);

  // A spectator has no keyboard board — the same seat check KeyboardController bails on (`=== null`
  // there; `== null` here also covers an unset seat) — and without a game there is nothing to
  // render. Both are whole-component states, not per-button.
  if (!gameState || humanPlayerIndex == null) return null;

  const isHumanTurn = gameState.turnOrder[gameState.currentPlayerIndex] === humanPlayerIndex;
  const areas = gameState.areas;

  /*
   * The move list, once per render rather than once per button — every name is
   * cut from the same list, and asking the engine per territory would walk the
   * whole board once per territory.
   *
   * Null on an AI's turn, and that is the guard rather than the selection: the
   * AI loop writes its own `selectedFrom` for the attack it is animating, so a
   * check for a selection alone would sort the board into targets of a move
   * that is not the player's to make. getValidMoves is asked for the CURRENT
   * player, which is the human exactly when this is non-null.
   */
  const moves = isHumanTurn ? getValidMoves(gameState) : [];
  const board = isHumanTurn
    ? {
        selectedFrom,
        sources: new Set(moves.map(m => m.from)),
        targets: new Set(moves.filter(m => m.from === selectedFrom).map(m => m.to)),
      }
    : null;

  /*
   * Ids run from 1, so slot 0 is never visited. Both halves of the guard are still load-bearing,
   * and each catches what the other cannot: the engine's `areas` is a dense `Area[]` whose unused
   * slots are TRUTHY sentinels (`{ size: 0, owner: -1 }`), which only `area.size === 0` rejects,
   * while `!area` covers the object fixtures' explicit `0: null` gaps and any index past the end.
   * The `.length || keys + 1` shape is what lets those object fixtures walk the same loop as the
   * real array.
   */
  const buttons = [];
  for (let a = 1; a < (areas.length || Object.keys(areas).length + 1); a++) {
    const area = areas[a];
    if (!area || area.size === 0) continue;
    buttons.push(
      <button
        type="button"
        key={a}
        id={areaElementId(a)}
        tabIndex={isHumanTurn && area.owner === humanPlayerIndex ? 0 : -1}
        onClick={() => onSelect(a)}
      >
        {areaLabel(a, area, humanPlayerIndex, playerNames, board)}
      </button>
    );
  }

  return (
    <div
      role="application"
      aria-label="Game board. Arrow keys move between territories, Enter attacks, E ends your turn"
      className="sr-only"
    >
      {buttons}
    </div>
  );
}
