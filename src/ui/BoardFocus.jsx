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
import { spokenName } from './spokenName.js';
import { areaElementId } from '../controller/KeyboardController.js';

/**
 * What a screen reader reads out when the territory takes focus — the button's
 * text content, so it is the accessible name with no `aria-label` to drift from
 * it. No trailing period: this is a name, not a sentence, and readers pause on
 * the commas anyway.
 *
 * The owner is spoken before the dice because spokenName brings its own
 * trailing comma on a repeated name ("Balanced AI, player 3,"), which flows
 * straight into the dice clause where a possessive could not.
 *
 * @param {number} id - Area id
 * @param {import('../engine/types.js').Area} area
 * @param {number} humanPlayerIndex
 * @param {string[] | undefined} playerNames
 * @returns {string}
 */
function areaLabel(id, area, humanPlayerIndex, playerNames) {
  const dice = area.dice === 1 ? '1 die' : `${area.dice} dice`;

  // Defensive: MapGenerator gives every live area an owner, so this is a torn-state guard rather
  // than a state the player can reach — it honours the `Area` typedef's "-1 = unowned" contract.
  if (typeof area.owner !== 'number' || area.owner < 0) {
    return `Territory ${id}, unowned, ${dice}`;
  }

  if (area.owner === humanPlayerIndex) return `Territory ${id}, yours, ${dice}`;

  const spoken = spokenName(playerNames, area.owner);
  const ownerClause = spoken.endsWith(',') ? spoken : `${spoken},`;
  return `Territory ${id}, owned by ${ownerClause} ${dice}`;
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

  // A spectator has no keyboard board — the same seat check KeyboardController bails on (`=== null`
  // there; `== null` here also covers an unset seat) — and without a game there is nothing to
  // render. Both are whole-component states, not per-button.
  if (!gameState || humanPlayerIndex == null) return null;

  const isHumanTurn = gameState.turnOrder[gameState.currentPlayerIndex] === humanPlayerIndex;
  const areas = gameState.areas;

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
        {areaLabel(a, area, humanPlayerIndex, playerNames)}
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
