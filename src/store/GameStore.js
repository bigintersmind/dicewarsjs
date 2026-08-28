/**
 * Observable Game Store
 *
 * Lightweight pub/sub state container.  The GameController pushes state
 * here; the Preact UI subscribes to changes via the useGameStore hook.
 * The renderer is updated imperatively by the controller.
 *
 * @module store/GameStore
 */

import { DIFFICULTY_MODES } from '../ai/difficultyModes.js';
import { DEFAULT_LUCK } from '../utils/config.js';

/** @typedef {'title' | 'mapPreview' | 'playing' | 'gameOver' | 'arena' | 'tournament' | 'replay' | 'onlineLeaderboard'} Screen */
/** @typedef {'idle' | 'battle'} AnimationPhase */
/** @typedef {'selectFrom' | 'selectTo' | null} AwaitingInput */

/**
 * @typedef {Object} StoreState
 * @property {import('../engine/types.js').GameState | null} gameState
 * @property {Screen} screen
 * @property {number | null} selectedFrom
 * @property {number | null} selectedTo
 * @property {Object | null} battleResult - The engine's BattleResult for the
 *   attack currently on screen — { attackerRoll, defenderRoll, success } —
 *   plus `attacker` and `defender`, the seat indices the controller reads off
 *   the board the attack was ROLLED on. The result itself carries no seats, and
 *   the DEFENDER's cannot be recovered from the state published beside it: a
 *   won attack has already handed the target to the attacker there. The live
 *   region uses them to say whose attack it was and whose territory was under
 *   it. Null between attacks — every attack path nulls it once the animation is
 *   done.
 * @property {AnimationPhase} animationPhase
 * @property {AwaitingInput} awaitingInput
 * @property {number | null} humanPlayerIndex
 * @property {number[] | null} candidateAreas - Territories the board hints are
 *   currently outlining for the human player: every territory that could start
 *   an attack while awaiting `selectFrom`, or the reachable enemies of
 *   `selectedFrom` while awaiting `selectTo`. Three distinct states, and the
 *   empty one is not the null one: `[]` means it IS the human's move but
 *   nothing qualifies (no territory with 2+ dice next to an enemy, or a
 *   selected source with nothing reachable), while `null` means no hint applies
 *   at all — the `boardHints` preference is off, nobody is playing
 *   (`humanPlayerIndex === null`), it is an AI's turn, or an animation owns the
 *   board. Written only by GameController, the single owner of the mapping onto
 *   HexGridRenderer.setCandidateHighlights. Nothing in the UI reads it yet; it
 *   is published so an observer can (the text hints parked in #196 would be the
 *   first).
 * @property {number | null} focusedAreaId - The territory whose BoardFocus
 *   button currently holds DOM focus, and null whenever focus is anywhere else
 *   (a control, `<body>`, another window). A mirror, not a source: the board is
 *   real DOM since #211, and KeyboardController's focusin/focusout listeners
 *   copy every focus move into this field, whatever caused it — Tab, an arrow,
 *   a click, a dialog restoring focus. The renderer's focus ring is visible
 *   exactly when this is non-null (#211 item 3): the mid-game seams clear the
 *   board with clearSelectionHighlights(), which leaves the focus layer alone,
 *   so the ring neither points somewhere focus is not nor goes missing while
 *   this is set. GameController nulls it at game over, spectate, quit to title
 *   and the end-turn error bounce — the places the playing screen unmounts the
 *   buttons under focus, which fires no event that can be relied on — and at
 *   game start; each of those paired with the renderer's clearFocusHighlight()
 *   or clearHighlights() in the same function.
 * @property {boolean} humanEliminated
 * @property {'turnLimit' | null} gameOverReason - Why a game ended without a conqueror.
 *   'turnLimit' when the browser turn cap (GameController MAX_GAME_TURNS) drew a stalled
 *   AI-vs-AI board; null for a normal conquest win or a still-running game.
 * @property {boolean} quitConfirmOpen - True while the in-game "Abandon this
 *   game?" dialog is up (#181). Lives in the store rather than in component
 *   state because the controller layer reads it too: KeyboardController
 *   suspends board navigation and handleTerritoryClick ignores clicks while it
 *   is open.
 * @property {boolean} rulesOpen - True while the "How to play" reference card
 *   is up. Screen-independent: App mounts RulesModal outside the screen switch,
 *   so the card survives a screen change underneath it (an AI can finish the
 *   game while a player is reading). Like quitConfirmOpen the controller layer
 *   reads it — KeyboardController suspends board navigation and
 *   handleTerritoryClick ignores clicks — and QuitConfirm defers Escape to it.
 * @property {boolean} settingsOpen - True while the settings dropdown (the die
 *   at the top right) is open. SettingsPanel is its only writer: this is the
 *   panel's own open state, kept here rather than in component state because
 *   KeyboardController reads it — the board's keys stand down while the
 *   dropdown is up, as behind the two flags above, so E cannot end the turn
 *   behind it (#211 item 8). Keys only: the dropdown has no scrim, and a
 *   pointerdown on the board both lands and closes it (the canvas handler runs
 *   before the panel's document-level click-outside), so handleTerritoryClick
 *   deliberately does not read this flag. No navigation seam resets it either:
 *   the panel is mounted outside the screen switch and stays as the player
 *   left it across a screen change, and since it gates no click, a flag stuck
 *   true would cost the arrow/E/Escape shortcuts, not the game — Tab and Enter
 *   still reach every territory and END TURN.
 * @property {number} aiSpeed
 * @property {boolean} soundEnabled
 * @property {string | null} error
 * @property {string[]} aiLoadWarnings - Per-slot notices when a chosen bot
 *   failed to load and was replaced by the default AI (shown on map preview).
 * @property {string[]} playerNames - Player-facing name of whoever holds each
 *   seat, indexed by player id: the picker's label for the bot that actually
 *   loaded there (post-fallback), or HUMAN_PLAYER_NAME for the human. Recorded
 *   by the controller with the lineup at game start (written in the same
 *   setState as the new gameState, cleared with the rest of the per-game state)
 *   and not revised afterwards — startSpectate's takeover of the eliminated
 *   human seat leaves its "You" in place, deliberately. The in-game text
 *   ("Conqueror is thinking...", "Blitz wins!") reads it via playerName() so an
 *   opponent has an identity rather than a seat number; the visual labels lean
 *   on the seat color to tell two Conquerors apart. Speech has no color, so
 *   spokenName() (src/ui/spokenName.js) adds the seat number to a repeated
 *   name — one rule, serving both channels that speak a seat: the live region
 *   and the territory buttons' accessible names.
 * @property {Object} config - Per-game setup carried between the title screen and
 *   the controller: { playerCount, mapSize, difficulty, aiAssignments, luck }.
 * @property {Object | null} currentReplay
 */

const DEFAULT_STATE = {
  gameState: null,
  screen: 'title',
  selectedFrom: null,
  selectedTo: null,
  battleResult: null,
  animationPhase: 'idle',
  awaitingInput: null,
  humanPlayerIndex: 0,
  humanEliminated: false,
  gameOverReason: null,
  quitConfirmOpen: false,
  rulesOpen: false,
  settingsOpen: false,
  aiSpeed: 1,
  soundEnabled: true,
  error: null,
  aiLoadWarnings: [],
  playerNames: [],
  currentReplay: null,
  replayOrigin: null,
  focusedAreaId: null,
  candidateAreas: null,
  preferences: {
    theme: 'dark',
    colorBlindMode: false,
    diceDisplayMode: 'dice',
    animationSpeed: 1,
    reducedMotion: 'system',
    boardHints: 'on',
  },
  config: {
    playerCount: 7,
    mapSize: 'medium',
    /*
     * Difficulty ladder (#167): the shipped default is Standard — original-game
     * parity, the classic ai_default in every AI seat. The #164 persona-led
     * lineup lives on as the Hard preset (src/ai/difficultyModes.js); 'custom'
     * means the player hand-picked slots on the title screen. Copied so store
     * updates never mutate the preset.
     */
    difficulty: 'standard',
    aiAssignments: [...DIFFICULTY_MODES.standard.lineup],
    /*
     * "Your luck" rung (#179): the per-seat dice handicap — the human seat
     * rolls `luck` extra dice and drops the `luck` lowest, attacking and
     * defending. 0 = Normal (off, the default). LUCK_LEVELS in
     * src/utils/config.js owns the ladder; the controller turns it into the
     * engine's `config.handicap`, and derives no handicap for spectator games
     * (the rung itself is kept as picked). A Custom-only setting: the controller
     * stores what `resolveLuck(difficulty, luck)` plays, so this is never
     * non-zero alongside a preset difficulty, and the title screen seeds from
     * it only when `difficulty === 'custom'`.
     */
    luck: DEFAULT_LUCK,
  },
};

/** The human seat's entry in `playerNames` (and in a game replay's `bots`). */
export const HUMAN_PLAYER_NAME = 'You';

/**
 * Player-facing name for a seat: the store's `playerNames` entry, or the seat
 * number ("Player 3") when none is recorded for it — a lineup that was never
 * recorded (`playerNames: []`, the store default) or an index past its end
 * still gets a readable label rather than a blank.
 *
 * @param {string[] | undefined} playerNames - StoreState.playerNames
 * @param {number} playerId
 * @returns {string}
 */
export function playerName(playerNames, playerId) {
  return playerNames?.[playerId] ?? `Player ${playerId + 1}`;
}

/**
 * Create an observable game store.
 *
 * @param {Partial<StoreState>} [initialOverrides] - Override default values
 * @returns {{ getState, setState, subscribe, select }}
 */
export function createGameStore(initialOverrides) {
  let state = { ...DEFAULT_STATE, ...initialOverrides };
  const listeners = new Set();

  function getState() {
    return state;
  }

  /**
   * Shallow-merge partial updates and notify subscribers.
   * @param {Partial<StoreState>} partial
   */
  function setState(partial) {
    const prev = state;
    state = { ...state, ...partial };
    for (const fn of listeners) {
      try {
        fn(state, prev);
      } catch (err) {
        console.error('[GameStore] Subscriber threw:', err);
      }
    }
  }

  /**
   * Subscribe to state changes.
   * @param {(next: StoreState, prev: StoreState) => void} listener
   * @returns {() => void} unsubscribe function
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Read a derived value without subscribing.
   * @template T
   * @param {(s: StoreState) => T} selectorFn
   * @returns {T}
   */
  function select(selectorFn) {
    return selectorFn(state);
  }

  return { getState, setState, subscribe, select };
}
