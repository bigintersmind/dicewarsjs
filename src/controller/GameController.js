/**
 * Game Controller
 *
 * Orchestrates the game loop. Connects the pure engine, renderer, store,
 * and sound system.  The controller is the only module that calls engine
 * functions and pushes state into the store.
 *
 * @module controller/GameController
 */

import {
  createGame,
  applyAction,
  getValidMoves,
  ACTION_TYPES,
  GAME_PHASES,
} from '../engine/index.js';
import { runAI } from '../engine/AIAdapter.js';
import { AI_STRATEGIES, getAIById, getAIImplementation } from '../ai/aiConfig.js';
import { createReplayFromState } from '../arena/replayFormat.js';
import { getCommunityBotList, loadCommunityBot } from '../arena/communityBots.js';
import { adaptModernBot } from '../arena/modernBotAdapter.js';
import { HUMAN_PLAYER_NAME, playerName } from '../store/GameStore.js';
import { resolveMapSize, luckToHandicap, resolveLuck } from '../utils/config.js';

/** Prefix marking a per-slot assignment id as a curated community bot. */
const COMMUNITY_PREFIX = 'community:';

/**
 * Hard turn budget for a browser game, counted in completed player-turns
 * (`state.turnsTaken`). The engine only ends a game on total conquest (active ≤ 1) — it
 * has no natural draw — and, unlike the headless drivers, the browser loop
 * (endTurn → startTurn) has no built-in bound. So an AI-vs-AI free-for-all where the
 * leader turtles behind maxed 8-dice borders would hang forever.
 *
 * Set below the headless stalemate cap (matchRunner `DEFAULT_MAX_TURNS` / GameRunner
 * `maxTurns` = 500): a browser game is watched turn-by-turn with animation, so a stalled
 * board should be called a draw well before a headless batch run would bother. 300
 * player-turns (~43 rounds of a 7-player game) still comfortably clears any genuinely
 * decisive game — a game that reaches it is stalled — while ending a hang in a fraction
 * of the wait. 300 sits well below the arena's 500-turn stalemate cap, so any board still
 * unresolved here is stalled by any reasonable measure. (Containment runs this way: every
 * game the arena scores a stalemate at 500 was already unresolved at 300, so arena
 * stalemates ⊆ browser draws — the browser draws the strict superset.) Exported so the
 * boundary tests read the same source of truth.
 */
export const MAX_GAME_TURNS = 300;

/**
 * Resolve a single per-slot assignment id to an engine-callable AI function.
 * Community ids (prefixed `community:`) are compiled and reverse-adapted so the
 * in-game loop can drive them; everything else is a built-in strategy id.
 *
 * @param {string} aiId
 * @returns {Promise<Function>}
 */
async function resolveAIFunction(aiId) {
  if (aiId.startsWith(COMMUNITY_PREFIX)) {
    const communityId = aiId.slice(COMMUNITY_PREFIX.length);
    return adaptModernBot(loadCommunityBot(communityId), aiId);
  }
  return getAIImplementation(aiId);
}

/**
 * Player-facing name for a per-slot assignment id — the same label the title
 * screen's picker shows for that bot, so a seat reads in-game the way it was
 * chosen ("Conqueror is thinking...", not "Player 3"). Community ids resolve
 * through the registry (the `?? id` is defensive only: loadCommunityBot throws
 * first for an id the registry doesn't know, so that seat takes the fallback
 * path in loadAIFunctions and is named for ai_default). Built-in ids resolve
 * like getAIImplementation does (unknown → ai_default), so name and function
 * agree even for a stale id.
 *
 * @param {string} aiId
 * @returns {string}
 */
function displayNameFor(aiId) {
  if (aiId.startsWith(COMMUNITY_PREFIX)) {
    const communityId = aiId.slice(COMMUNITY_PREFIX.length);
    return getCommunityBotList().find(bot => bot.id === communityId)?.name ?? communityId;
  }
  return getAIById(aiId).name;
}

/**
 * Create a game controller.
 *
 * @param {Object} store - GameStore instance from createGameStore()
 * @param {import('../renderer/GameRenderer.js').GameRenderer | null} renderer
 * @param {Object | null} soundManager - Optional sound manager
 * @param {Object | null} [preferencesManager] - Optional PreferencesManager for reduced-motion
 * @returns {Object} GameController public API
 */
export function createGameController(store, renderer, soundManager, preferencesManager) {
  /** @type {(Function | null)[]} AI functions per player index (null = human) */
  let aiFunctions = [];
  /** @type {boolean} True while an AI turn is running */
  let aiRunning = false;
  /** @type {boolean} True when the controller should stop the current AI loop */
  let aiAborted = false;
  /** @type {import('../engine/types.js').GameState | null} Last state drawn by the replay viewer */
  let replayRenderedState = null;
  /**
   * @type {ReturnType<typeof setTimeout> | null} Pending "start the next turn"
   * timer scheduled by endTurn. Held so leaving the game can cancel it: a
   * stray startTurn() firing after goToTitle() has nulled `gameState` would
   * read that as a finished game and throw the player onto the game-over
   * screen (#181).
   */
  let nextTurnTimer = null;

  /** Cancel a pending next-turn timer, if any. */
  function clearNextTurnTimer() {
    if (nextTurnTimer !== null) {
      clearTimeout(nextTurnTimer);
      nextTurnTimer = null;
    }
  }

  /**
   * Build AI assignment array from config.
   *
   * Returns the per-slot functions, the per-slot display names, and any
   * player-facing notices: when a chosen bot fails to load we fall back to
   * ai_default, but silently swapping it in would misrepresent who the player
   * is up against — so those failures are surfaced (see startNewGame). The
   * names describe what actually loaded, fallback included, so the in-game
   * label never claims a bot that isn't playing.
   *
   * @param {number} playerCount
   * @param {boolean} spectator
   * @returns {Promise<{ fns: (Function | null)[], names: string[], warnings: string[] }>}
   */
  async function loadAIFunctions(playerCount, spectator) {
    const storeState = store.getState();
    const assignments = [...storeState.config.aiAssignments].slice(0, playerCount);

    // In spectator mode, all players are AI (playerCount, not assignments.length:
    // a lineup shorter than the seat count must not leave a seat human-and-idle).
    if (spectator) {
      for (let i = 0; i < playerCount; i++) {
        if (!assignments[i]) assignments[i] = 'ai_default';
      }
    }

    const fns = [];
    const names = [];
    const warnings = [];
    for (let i = 0; i < playerCount; i++) {
      const aiId = assignments[i];
      if (!aiId) {
        fns.push(null); // human
        names.push(HUMAN_PLAYER_NAME);
      } else {
        if (!aiId.startsWith(COMMUNITY_PREFIX) && !AI_STRATEGIES[aiId]) {
          // Not reachable from the title screen (it only emits registry ids), but
          // both resolvers substitute ai_default for an unknown id without a
          // throw — so say so, or a stale/renamed id would seat and label
          // Balanced AI as if it were chosen.
          console.warn(
            `[GameController] Unknown AI id "${aiId}" for player ${i}, substituting ai_default.`
          );
        }
        try {
          // Resolve both before pushing either: a throw between the two pushes
          // would leave fns one longer than names and shift every later seat.
          const fn = await resolveAIFunction(aiId);
          const name = displayNameFor(aiId);
          fns.push(fn);
          names.push(name);
        } catch (err) {
          console.error(
            `Failed to load AI "${aiId}" for player ${i}, falling back to ai_default:`,
            err
          );
          /*
           * Surface the swap either way. A community bot can have a bug, and a
           * built-in is a dynamic import (the personas pull a weights chunk on
           * top) that a network blip or a stale deploy can reject. Seating
           * ai_default silently would misrepresent who the player is up against
           * — all the more now that the seat is labeled by what actually loaded,
           * which would make the downgrade look deliberate. The notice names
           * the fallback the way the seat will (its picker label).
           */
          const fallbackName = getAIById('ai_default').name;
          const chosen = aiId.startsWith(COMMUNITY_PREFIX)
            ? `community bot "${aiId.slice(COMMUNITY_PREFIX.length)}"`
            : `"${AI_STRATEGIES[aiId]?.name ?? aiId}"`;
          warnings.push(
            `Player ${i + 1}: ${chosen} could not load. Using ${fallbackName} instead.`
          );
          try {
            fns.push(await getAIImplementation('ai_default'));
            names.push(fallbackName);
          } catch (fallbackErr) {
            throw new Error(
              `Cannot load any AI for player ${i}: both "${aiId}" and "ai_default" failed`,
              { cause: fallbackErr }
            );
          }
        }
      }
    }
    return { fns, names, warnings };
  }

  /**
   * Build a Replay object from the current game state.
   * Returns null if the state lacks config (e.g. in unit-test mocks).
   * @param {Object} state - Engine GameState
   * @returns {import('../arena/replayFormat.js').Replay | null}
   */
  function buildGameReplay(state) {
    if (!state || !state.config) return null;
    try {
      const { playerNames } = store.getState();
      const playerCount = state.config.playerCount;
      // The seat's real names (set with the lineup in startNewGame); playerName()
      // supplies the seat-number label for a lineup that was never recorded.
      const bots = Array.from({ length: playerCount }, (_, i) => playerName(playerNames, i));
      return createReplayFromState(state, {
        bots,
        winner: state.winner,
        turnCount: state.turnNumber,
      });
    } catch (err) {
      console.error('[GameController] Failed to build game replay:', err);
      return null;
    }
  }

  /**
   * Start a new game from the title screen.
   *
   * @param {Object} config
   * @param {number} config.playerCount
   * @param {boolean} config.spectator
   * @param {string} [config.mapSize]
   * @param {(string | null)[]} [config.aiAssignments] - Per-slot AI strategy IDs
   *   (index = player slot, null = human). Falls back to the store's current
   *   assignments when omitted.
   * @param {string} [config.difficulty] - Difficulty mode id ('easy' | 'standard'
   *   | 'hard' | 'custom') the lineup came from. Persisted so the title screen
   *   restores the selection on the next visit (and derives preset lineups from
   *   it); the controller itself only consumes aiAssignments.
   * @param {number} [config.luck] - "Your luck" rung (#179): 0 = Normal, 1 = Lucky,
   *   2 = Very lucky. A Custom-only setting — honoured when `difficulty` is
   *   'custom' and played as Normal under every preset (`resolveLuck`), so the
   *   stored value never carries a handicap behind a preset label. Carried in the
   *   store for the session (not localStorage) like mapSize, and turned into the
   *   engine's `config.handicap` for the human seat; stored as picked even in
   *   spectator mode, where the derived handicap is null (no human seat).
   */
  async function startNewGame(config) {
    aiAborted = true; // abort any running AI turn
    clearNextTurnTimer();
    /*
     * The banner and the load warnings belong to the start that is beginning
     * now, so they go here. The lineup does NOT, and the rule it follows instead
     * is: the names belong to the game they name (#211 item-3 addendum). They
     * are replaced wholesale by the game that replaces it — the success setState
     * below, in the same breath as the new gameState and screen — and emptied on
     * every route back to the title, where no game is named at all: goToTitle,
     * this function's own two title-bound failure exits, rejectMap's two
     * bounces, and endTurn's engine-error bounce. Never ahead of the game.
     *
     * Nothing today reaches startNewGame with names still set, so this is the
     * invariant stated structurally rather than a flash anyone has seen. Its one
     * caller is START on the title screen, where the lineup is already empty,
     * and HOME on the game-over card goes through goToTitle(), which empties
     * the names in the very setState that swaps the screen — the card unmounts
     * with them, leaving no window to read a stale lineup in. What the rule buys
     * is a future caller that does land here over a finished game: the card
     * would stay up for as long as the AI load below takes, and GameOverScreen
     * reads playerNames for "<name> wins!" while useAnnouncer has them in the
     * deps of its game-over effect — so emptying the lineup on the way in would
     * both degrade that subtitle to "Player 2 wins!" and have the live region
     * re-speak it that way. A test pins the seam.
     */
    store.setState({ error: null, aiLoadWarnings: [] });

    /*
     * No renderer at all, or one whose init() failed — two shapes of the same
     * "there is no board" (#211 follow-up 14). main.jsx assigns gameRenderer
     * before awaiting init(), and GameRenderer.init destroys and rethrows on
     * failure, so the failed object stays wired up with `initialized === false`
     * and no usable hex grid — null, or already destroyed by init()'s own
     * cleanup, which tears the grid down without nulling the reference.
     * Checking only `!renderer` let START carry that object all the way to the
     * playing screen: drawMap() no-ops with a warn, the board is blank, and the
     * first Tab hands that grid to KeyboardController's
     * `renderer.hexGrid.setFocusHighlight` — a throw in the common shape, where
     * it is still the constructor's null — after the `error: null` above had
     * already wiped the WebGL banner main.jsx put up. TitleAttractMode tests the
     * same pair before it starts its decorative game; this is the seam that
     * closes the hole for the real one, which is where it belongs — a guard at
     * each mid-game hexGrid call would only have moved the failure.
     */
    if (!renderer || !renderer.initialized) {
      store.setState({ error: 'Cannot start game: graphics engine not available.' });
      return;
    }

    // Preload sounds on first user gesture (autoplay policy)
    if (soundManager && soundManager.loadAll) {
      soundManager.loadAll().catch(err => {
        console.warn('Sound preload failed:', err);
      });
    }

    const playerCount = config.playerCount;
    const spectator = config.spectator;
    /*
     * Map size is a per-game choice from the title screen. Fall back to the
     * store's current value if the caller omits it.
     */
    const mapSize = config.mapSize ?? store.getState().config.mapSize;
    /*
     * Per-slot bot lineup chosen on the title screen. Fall back to the store's
     * current assignments when the caller omits it. loadAIFunctions reads this
     * from the store below, so it must be written before that call.
     */
    const aiAssignments = config.aiAssignments ?? store.getState().config.aiAssignments;

    const difficulty = config.difficulty ?? store.getState().config.difficulty;

    /*
     * "Your luck" rung (#179), resolved against the difficulty: only Custom plays
     * a rung, every preset plays Normal. That keeps the store's fallback honest
     * for a caller that omits `luck` — a stale Custom rung can't be inherited
     * into a preset game. Stored as the player picked it even in spectator mode —
     * the choice belongs to the title screen and must survive an AI-vs-AI
     * detour — but the handicap itself is derived from humanPlayerIndex, which is
     * null when nobody is playing, so a spectator game is unhandicapped.
     */
    const luck = resolveLuck(difficulty, config.luck ?? store.getState().config.luck);
    const humanPlayerIndex = spectator ? null : 0;
    /*
     * luckToHandicap throws on a rung that isn't on the ladder. That has to land
     * on the store's error path like every other start failure: START discards
     * this promise, so an escaping rejection would read as a dead button (and the
     * `error: null` reset above would already have wiped any visible banner).
     * Bailing here also keeps the bad rung out of store.config — the setState
     * that persists it is below. The lineup is emptied for the same reason the
     * catch below empties it: this is a route to the title, and the title names
     * no game. Today it empties nothing — see the note at the top of the
     * function — so it is the rule kept structural, not a stale lineup fixed.
     */
    let handicap;
    try {
      handicap = luckToHandicap(luck, humanPlayerIndex);
    } catch (err) {
      console.error('[GameController] Cannot start game: invalid luck setting', err);
      store.setState({
        screen: 'title',
        gameState: null,
        animationPhase: 'idle',
        awaitingInput: null,
        candidateAreas: null,
        quitConfirmOpen: false,
        rulesOpen: false,
        playerNames: [],
        error: "That luck setting isn't available. Pick another and try again.",
      });
      return;
    }

    /*
     * Update store config. Persist mapSize and luck so a later rejectMap()
     * regenerates at the same size, and with the same dice, the player chose.
     */
    store.setState({
      config: {
        ...store.getState().config,
        playerCount,
        mapSize,
        aiAssignments,
        difficulty,
        luck,
      },
      humanPlayerIndex,
    });

    try {
      // Load AI functions
      const { fns, names, warnings } = await loadAIFunctions(playerCount, spectator);
      aiFunctions = fns;

      // Create game via engine
      const gameState = createGame({
        playerCount,
        ...resolveMapSize(mapSize),
        handicap,
      });

      store.setState({
        gameState,
        screen: 'mapPreview',
        selectedFrom: null,
        selectedTo: null,
        battleResult: null,
        animationPhase: 'idle',
        awaitingInput: null,
        focusedAreaId: null,
        candidateAreas: null,
        humanEliminated: false,
        gameOverReason: null,
        /*
         * No path may carry a previous game's open dialog into this one (#181):
         * neither the quit confirm nor the rules card. The rules card is the
         * only overlay that survives a screen change on purpose (see openRules),
         * so a start seam is exactly where it has to be dropped — otherwise a
         * card left up by a throw inside the ErrorBoundary would gate every
         * click and keypress of the new game with no way back.
         */
        quitConfirmOpen: false,
        rulesOpen: false,
        aiLoadWarnings: warnings,
        playerNames: names,
      });
      /*
       * The ring, paired with the `focusedAreaId: null` above — by construction,
       * like every other seam that nulls the id (#211). The only production
       * route that reaches here with a ring up was the end-turn error bounce,
       * now closed at its own seam, but the invariant must not rest on a
       * whole-app reachability argument. drawMap() below retraces every border
       * and rescales, so a ring that survived would be old geometry at a new
       * scale. (`hexGrid` is null until init() succeeds — goToTitle's guard.)
       */
      if (renderer && renderer.hexGrid) renderer.hexGrid.clearFocusHighlight();

      // Draw the map in the renderer
      if (renderer) {
        renderer.drawMap(gameState);
      }
    } catch (err) {
      console.error('Failed to start new game:', err);
      /*
       * This is a trip back to the title, so it has to leave the same state
       * goToTitle() would (#181) — a confirm dialog raised over the previous
       * game must not still be flagged open on the title screen, and the lineup
       * goes with the game it named (goToTitle empties it too), the setState
       * that would have replaced it wholesale being the one that just threw. As
       * at the luck bail, there is in practice nothing here to empty: only the
       * title screen starts games. (aiAborted and the next-turn timer were
       * already dealt with on the way in.)
       */
      store.setState({
        screen: 'title',
        gameState: null,
        animationPhase: 'idle',
        awaitingInput: null,
        candidateAreas: null,
        quitConfirmOpen: false,
        rulesOpen: false,
        playerNames: [],
        error: 'Failed to start game. Please try again.',
      });
    }
  }

  /** Accept the current map and start playing. */
  function acceptMap() {
    store.setState({ screen: 'playing' });
    startTurn();
  }

  /** Reject the current map and generate a new one. */
  async function rejectMap() {
    const storeState = store.getState();
    const playerCount = storeState.config.playerCount;
    const mapSize = storeState.config.mapSize;
    /*
     * NEW MAP re-rolls the board, not the setup: the handicap has to be rebuilt
     * from the same stored luck rung and human seat, or the player's luck would
     * silently switch off the moment they rejected a map.
     */
    let handicap;
    try {
      handicap = luckToHandicap(
        resolveLuck(storeState.config.difficulty, storeState.config.luck),
        storeState.humanPlayerIndex
      );
    } catch (err) {
      // Same contract as startNewGame: a rung off the ladder is a store error, not a rejection.
      console.error('[GameController] Cannot regenerate map: invalid luck setting', err);
      store.setState({
        screen: 'title',
        gameState: null,
        candidateAreas: null,
        // Unlike startNewGame's exits this one really does have a lineup to
        // empty — NEW MAP is pressed over a named game — but it is the same
        // rule: no route to the title leaves a game named behind it.
        playerNames: [],
        error: "That luck setting isn't available. Pick another and try again.",
      });
      return;
    }

    let gameState;
    try {
      gameState = createGame({
        playerCount,
        ...resolveMapSize(mapSize),
        handicap,
      });
    } catch (err) {
      console.error('Failed to regenerate map:', err);
      store.setState({
        screen: 'title',
        gameState: null,
        candidateAreas: null,
        // The other half of the same rule as the luck bail above.
        playerNames: [],
        error: 'Map generation failed. Please try again.',
      });
      return;
    }

    store.setState({ gameState });
    if (renderer) {
      renderer.drawMap(gameState);
    }
  }

  /**
   * Go back to the title screen, abandoning any game in progress (#181).
   *
   * Everything the running game *drives* has to stop here, or it surfaces on
   * the title screen a moment later: the AI loop (aiAborted, checked after
   * every await), the pending next-turn timer, and the dice animation still
   * rolling on the canvas. The board's own selection highlight goes with them —
   * drawMap() doesn't clear highlights, so a stale gold outline would sit over
   * the attract-mode board. `currentReplay` is dropped with the rest — an
   * abandoned game is not a result worth reviewing, and nothing counts it.
   *
   * Two cosmetic animations are *not* stopped, because neither exposes a
   * handle to stop it with: the end-of-turn reinforcement flash and the win
   * celebration fade both run their ~1s out over the attract board. What
   * matters is that neither can act on the abandoned game afterwards — endTurn
   * and triggerGameOver both bail on the screen change once their await
   * returns.
   */
  function goToTitle() {
    aiAborted = true;
    clearNextTurnTimer();
    /*
     * Commit the navigation before touching the renderer: a throw out of a
     * renderer call would otherwise leave the store on 'playing' with the
     * confirm dialog still up (a throw from a UI event handler never reaches
     * the ErrorBoundary).
     */
    store.setState({
      screen: 'title',
      gameState: null,
      selectedFrom: null,
      selectedTo: null,
      battleResult: null,
      animationPhase: 'idle',
      awaitingInput: null,
      focusedAreaId: null,
      candidateAreas: null,
      currentReplay: null,
      replayOrigin: null,
      humanEliminated: false,
      gameOverReason: null,
      quitConfirmOpen: false,
      rulesOpen: false,
      playerNames: [],
    });
    /*
     * `battle` and `hexGrid` are both null until init() succeeds, and quitting
     * is reachable (via the menu screens) even after the renderer failed to come
     * up — so both are null-checked, unlike the mid-game call sites.
     */
    if (renderer) {
      if (renderer.battle) renderer.battle.cancel();
      if (renderer.hexGrid) renderer.hexGrid.clearHighlights();
    }
  }

  /**
   * Ask to abandon the game in progress: raises the confirm dialog (#181).
   * Only meaningful while playing — the title screen has nothing to abandon.
   */
  function openQuitConfirm() {
    if (store.getState().screen !== 'playing') return;
    store.setState({ quitConfirmOpen: true });
  }

  /** Dismiss the quit confirm, leaving the game exactly as it was. */
  function closeQuitConfirm() {
    store.setState({ quitConfirmOpen: false });
  }

  /*
   * The "How to play" reference. Unlike the quit confirm it is not tied to a
   * screen — every screen offers a way in, and a game running behind the card
   * (an AI turn finishing, even the game ending) leaves it exactly where the
   * player left it, so triggerGameOver deliberately does not touch the flag.
   *
   * The navigation seams that start or abandon a game do clear it, though
   * (startNewGame, goToTitle, the two error bounces): `rulesOpen` gates every
   * click and keypress while it is set, so a card the player can no longer see
   * — one whose render threw inside the ErrorBoundary — would otherwise lock
   * the game with no way out, not even quit-and-restart.
   */
  function openRules() {
    store.setState({ rulesOpen: true });
  }

  /** Dismiss the reference card. */
  function closeRules() {
    store.setState({ rulesOpen: false });
  }

  function goToArena() {
    aiAborted = true;
    store.setState({ screen: 'arena' });
  }

  function goToTournament() {
    aiAborted = true;
    store.setState({ screen: 'tournament' });
  }

  function goToOnlineLeaderboard() {
    aiAborted = true;
    store.setState({ screen: 'onlineLeaderboard' });
  }

  function goToReplay(replay) {
    aiAborted = true;
    store.setState({ screen: 'replay', currentReplay: replay });
  }

  /**
   * Start the current player's turn.
   * If AI, runs the AI turn automatically.
   * If human, sets awaitingInput.
   */
  function startTurn() {
    const state = store.getState().gameState;
    if (!state || state.phase === GAME_PHASES.GAME_OVER) {
      store.setState({ screen: 'gameOver' });
      return;
    }

    const currentPlayerId = state.turnOrder[state.currentPlayerIndex];
    const humanIdx = store.getState().humanPlayerIndex;
    const isHuman = currentPlayerId === humanIdx;

    if (isHuman) {
      store.setState({ awaitingInput: 'selectFrom' });
      refreshCandidateHighlights();
      if (soundManager) soundManager.play('myturn');
    } else {
      refreshCandidateHighlights(); // clears: no hints on an AI's turn
      runAITurn(currentPlayerId);
    }
  }

  /**
   * Run a full AI turn step-by-step for animation.
   * @param {number} playerId
   */
  async function runAITurn(playerId) {
    if (aiRunning) return;
    aiRunning = true;
    aiAborted = false;

    const aiFunc = aiFunctions[playerId];
    if (!aiFunc) {
      // No AI function — just end turn
      endTurn();
      aiRunning = false;
      return;
    }

    let state = store.getState().gameState;
    let invalidCount = 0;
    const maxMoves = 100;

    for (let i = 0; i < maxMoves; i++) {
      if (aiAborted) break;
      if (!state || state.phase === GAME_PHASES.GAME_OVER) break;

      // Get one move from the AI
      let move;
      try {
        move = runAI(state, aiFunc);
      } catch (err) {
        console.error(`AI move failed for player ${playerId}:`, err);
        break;
      }

      if (!move) break; // AI ends its turn

      // Validate the move
      const validMoves = getValidMoves(state);
      const isValid = validMoves.some(m => m.from === move.from && m.to === move.to);

      if (!isValid) {
        invalidCount++;
        if (invalidCount >= 3) {
          console.warn(`AI player ${playerId} force-stopped: 3 consecutive invalid moves`);
          break;
        }
        continue;
      }

      // Apply the attack
      const prevState = state;
      try {
        state = applyAction(state, {
          type: ACTION_TYPES.ATTACK,
          from: move.from,
          to: move.to,
        });
      } catch (err) {
        console.error('AI attack action failed:', err);
        break;
      }

      invalidCount = 0;

      // Extract battle result from the latest history entry
      const lastAction = state.history[state.history.length - 1];
      const battleResult = lastAction ? lastAction.result : null;

      /*
       * The two seats, from the board the attack was rolled on — prevState,
       * because a won attack has already flipped the target's owner in the
       * state being published. The live region asks whether the territory an AI
       * just attacked was the human's (#211 item 10), and the dice animation
       * asks for the same pair to color the two hands.
       */
      const atkOwner = prevState.areas[move.from].owner;
      const defOwner = prevState.areas[move.to].owner;

      store.setState({
        gameState: state,
        battleResult: battleResult
          ? { ...battleResult, attacker: atkOwner, defender: defOwner }
          : null,
        animationPhase: 'battle',
        selectedFrom: move.from,
        selectedTo: move.to,
      });

      // Update renderer
      if (renderer) {
        renderer.update(prevState, state);
      }

      // Play battle animation or brief delay
      const speed = getEffectiveSpeed();
      if (renderer && renderer.battle && battleResult) {
        await renderer.battle.play(battleResult, atkOwner, defOwner, { speed });
      } else {
        await delay(300 / speed);
      }

      /*
       * The player may have quit while that animation played (#181): the loop's
       * top-of-iteration abort check is too late — the rest of this iteration
       * would write battle state, sound and particles onto the title screen
       * and, if that attack eliminated the human, hand off to triggerGameOver()
       * at the elimination check below.
       */
      if (aiAborted) {
        // Leave no half-played attack behind, whichever navigation aborted us.
        store.setState({
          battleResult: null,
          animationPhase: 'idle',
          selectedFrom: null,
          selectedTo: null,
        });
        /*
         * clearSelectionHighlights() here is uniformity, not a behavioural
         * requirement: every route that sets aiAborted — goToTitle, startNewGame,
         * startSpectate, the end-turn error bounce — takes the ring down itself,
         * paired with its own store write, so there is never a ring left for this
         * cleanup to deal with (#211).
         */
        if (renderer) renderer.hexGrid.clearSelectionHighlights();
        aiRunning = false;
        return;
      }

      // Sound effects (after animation)
      if (soundManager && battleResult) {
        soundManager.play(battleResult.success ? 'success' : 'fail');
      }

      // Visual effects for AI attacks
      if (renderer && battleResult && !isReducedMotion()) {
        if (battleResult.success) {
          try {
            const atkColor = renderer.getPlayerColor(prevState.areas[move.from].owner);
            renderer.playParticleEffect(move.to, atkColor);
          } catch (err) {
            console.error('[GameController] AI particle effect failed:', err);
          }
        }
        try {
          const atkDice = prevState.areas[move.from]?.dice || 0;
          const defDice = prevState.areas[move.to]?.dice || 0;
          const totalDice = atkDice + defDice;
          if (totalDice >= 10) renderer.screenShake(3, 200);
        } catch (err) {
          console.error('[GameController] AI screen shake failed:', err);
        }
      }

      store.setState({
        battleResult: null,
        animationPhase: 'idle',
        selectedFrom: null,
        selectedTo: null,
      });

      if (renderer) {
        renderer.hexGrid.clearSelectionHighlights();
      }

      // Check if human has been eliminated (but game continues)
      const humanIdx = store.getState().humanPlayerIndex;
      if (
        humanIdx !== null &&
        state.players[humanIdx]?.eliminated === true &&
        state.phase !== GAME_PHASES.GAME_OVER
      ) {
        await triggerGameOver(state);
        aiRunning = false;
        return;
      }

      // Check if game is over
      if (state.phase === GAME_PHASES.GAME_OVER) break;
    }

    /*
     * Belt and braces: a quit that lands while the loop is awaiting is caught by
     * the in-loop check above (which returns), and nothing yields between there
     * and the top of the next iteration — so this is only reachable if something
     * flips the flag synchronously mid-iteration. Kept so the loop can never
     * fall through to endTurn()/triggerGameOver() after a quit (#181).
     */
    if (aiAborted) {
      aiRunning = false;
      return;
    }

    if (state && state.phase !== GAME_PHASES.GAME_OVER) {
      await endTurn();
    } else if (state && state.phase === GAME_PHASES.GAME_OVER) {
      await triggerGameOver(state);
    }

    aiRunning = false;
  }

  /**
   * Can this territory start an attack at all — 2+ dice AND a live enemy next
   * door?
   *
   * Asked of the engine's own getValidMoves rather than re-derived here, so the
   * click, the board hints and the territory buttons' spoken names are three
   * readings of one rule and cannot drift from each other or from what
   * applyAction will accept (#204). The hint set (`store.candidateAreas`) is the
   * wrong source for it: that is null whenever the boardHints preference is off,
   * and the rule holds whether or not the player can see it.
   *
   * @param {Object} state - Engine game state
   * @param {number} areaId
   * @returns {boolean}
   */
  function canAttackFrom(state, areaId) {
    return getValidMoves(state).some(m => m.from === areaId);
  }

  /**
   * Territories the board hints should be outlining for the human right now, or
   * null when no hint applies.
   *
   * Derived from the engine's own `getValidMoves`, so what the board offers and
   * what the rules allow can't drift apart: while awaiting `selectFrom` it is
   * every territory that could start an attack (2+ dice AND an enemy neighbor);
   * while awaiting `selectTo` it is the enemies the chosen territory can
   * actually reach.
   *
   * @param {Object} storeState - Current store state
   * @returns {number[] | null}
   */
  function computeCandidateAreas(storeState) {
    const state = storeState.gameState;
    if (!state) return null;
    // No hints for a spectator (nobody is playing), or with the pref off.
    if (storeState.humanPlayerIndex === null) return null;
    /*
     * The preferences manager is the source of truth, exactly as isReducedMotion
     * treats it; the store's copy is a mirror kept in sync by a main.jsx
     * subscriber, so reading it here would quietly depend on that subscriber
     * running first. Falls back to the mirror when no manager was supplied.
     */
    const hints = preferencesManager
      ? preferencesManager.get('boardHints')
      : (storeState.preferences?.boardHints ?? 'on');
    if (hints === 'off') return null;
    // Nor on an AI's turn.
    if (state.turnOrder[state.currentPlayerIndex] !== storeState.humanPlayerIndex) return null;

    if (storeState.awaitingInput === 'selectFrom') {
      return [...new Set(getValidMoves(state).map(m => m.from))];
    }
    if (storeState.awaitingInput === 'selectTo' && storeState.selectedFrom != null) {
      return getValidMoves(state)
        .filter(m => m.from === storeState.selectedFrom)
        .map(m => m.to);
    }
    // awaitingInput is null while an animation owns the board — nothing to offer.
    return null;
  }

  /**
   * The single seam between the game state and the board hints: recompute the
   * candidate set, publish it to the store (for observers — none in the UI yet)
   * and paint it (for the player). Idempotent — every caller just calls it after
   * whatever it changed, rather than each working out what the board should
   * show.
   *
   * Call it AFTER any `clearSelectionHighlights()` (or `clearHighlights()`),
   * which deliberately wipes this layer along with the selection.
   */
  function refreshCandidateHighlights() {
    const candidates = computeCandidateAreas(store.getState());
    /*
     * Skip the write when nothing was on offer and nothing is: every AI-turn
     * seam passes through here, and a null-over-null setState still notifies
     * every store subscriber, re-rendering UI that reads none of this.
     */
    if (candidates !== null || store.getState().candidateAreas !== null) {
      store.setState({ candidateAreas: candidates });
    }

    if (!renderer || !renderer.hexGrid) return;
    if (candidates && candidates.length > 0) {
      const kind = store.getState().awaitingInput === 'selectTo' ? 'target' : 'attacker';
      renderer.hexGrid.setCandidateHighlights(candidates, kind);
    } else {
      renderer.hexGrid.clearCandidateHighlights();
    }
  }

  /**
   * Put the board back on offering sources: nothing selected, nothing
   * half-made, the attack candidates up again.
   *
   * The owner of those three steps for the two paths that DROP a selection —
   * the player changing their mind (`cancelSelection` below) and the engine
   * refusing a move (`executeAttack`'s catch) — because a second copy is a
   * second chance for the order to drift. (The post-attack seam runs the same
   * order for a third reason and cannot share this: its store write has to
   * carry `battleResult`/`animationPhase` in the same setState, and
   * `awaitingInput` is null when the game just ended.) The store write names
   * `selectedTo` too, though every path that reaches here already has it null
   * (the post-attack seam clears it): the catch's own write did, and one body
   * keeps one shape. The order is the point: the store goes back to selectFrom
   * BEFORE the refresh, or the hints would be recomputed against a stale
   * 'selectTo' and repaint the old source's reachable enemies; and the clear
   * comes before the refresh, or it would wipe the hints the refresh just
   * painted.
   */
  function resetSelection() {
    store.setState({ selectedFrom: null, selectedTo: null, awaitingInput: 'selectFrom' });
    /*
     * The selection and the keyboard's focus are different things, and only the
     * selection was dropped — so this is clearSelectionHighlights(), which
     * leaves the ring where DOM focus still is (#211 item 3).
     */
    if (renderer) renderer.hexGrid.clearSelectionHighlights();
    // ...which takes the board hints down with it, and this is a return to
    // selectFrom, so the attack candidates have to be painted again.
    refreshCandidateHighlights();
  }

  /**
   * Drop a half-made attack: back to picking a source, the selection off the
   * board, the attack candidates back up.
   *
   * The owner of the PLAYER-facing cancel, because two inputs run it — Escape
   * (KeyboardController hands it straight here) and a click on water below
   * (#211 follow-up 16). Everything it does to the board is `resetSelection`
   * above, which `executeAttack`'s rejected-move catch shares rather than
   * copying; that path cannot come through here, having already set
   * `awaitingInput: null` — which is exactly what the guard below rejects.
   *
   * A mid-game call, both callers gated on the playing screen, so it assumes a
   * drawn board the way every mid-game call does (see KeyboardController's
   * header for the model).
   *
   * @returns {boolean} True when there was actually a selection to cancel —
   *   which is KeyboardController's cue to claim the Escape (#181).
   */
  function cancelSelection() {
    if (store.getState().awaitingInput !== 'selectTo') return false;
    resetSelection();
    return true;
  }

  /**
   * Handle a click on the board during a human turn.
   *
   * @param {number} areaId - The clicked territory, or 0 for WATER: the hit test
   *   found no territory under the pointer. Water cancels a half-made attack and
   *   is otherwise a no-op.
   */
  function handleTerritoryClick(areaId) {
    const storeState = store.getState();
    const state = storeState.gameState;
    if (!state || storeState.screen !== 'playing') return;
    if (storeState.animationPhase !== 'idle') return;
    // A modal over the board owns input while it is up (its scrim already eats
    // the click; this keeps the contract true whatever the pointer layer does).
    // The settings dropdown is deliberately not in this list: it has no scrim,
    // and the canvas's pointerdown runs before its click-outside closes it, so
    // a click both lands and closes it — only the keys stand down (#211 item 8).
    if (storeState.quitConfirmOpen || storeState.rulesOpen) return;

    const currentPlayerId = state.turnOrder[state.currentPlayerIndex];
    if (currentPlayerId !== storeState.humanPlayerIndex) return;

    /*
     * Water, and the player is mid-attack: clicking off the board is a plain
     * way to say "not that one after all", so it drops the selection rather
     * than leaving it half-made until the next Escape (#211 follow-up 16).
     * Deliberately below the gates rather than above them: cancelling is the
     * player acting on their own turn, so it answers to the same four
     * conditions a territory click does — not on an AI's turn, not mid-animation,
     * not from under a modal. (The keyboard's own position is a separate layer
     * and this does not touch it: the ring comes down because the browser blurs
     * the board to `<body>`, which is the canvas handler's note to explain.)
     */
    if (areaId === 0) {
      cancelSelection();
      return;
    }

    const area = state.areas[areaId];
    if (!area) return;

    if (storeState.awaitingInput === 'selectFrom') {
      // Select attack source
      if (area.owner !== currentPlayerId) return;
      if (!canAttackFrom(state, areaId)) return;

      store.setState({ selectedFrom: areaId, awaitingInput: 'selectTo' });
      if (renderer) {
        renderer.hexGrid.clearSelectionHighlights();
        renderer.hexGrid.setHighlight('from', areaId);
      }
      refreshCandidateHighlights();
      if (soundManager) soundManager.play('click');
    } else if (storeState.awaitingInput === 'selectTo') {
      // If clicking own territory again, reselect
      if (area.owner === currentPlayerId) {
        if (!canAttackFrom(state, areaId)) return;
        store.setState({ selectedFrom: areaId, awaitingInput: 'selectTo' });
        if (renderer) {
          renderer.hexGrid.clearSelectionHighlights();
          renderer.hexGrid.setHighlight('from', areaId);
        }
        refreshCandidateHighlights();
        if (soundManager) soundManager.play('click');
        return;
      }

      /*
       * Validate attack target: the same rule as the source, one step on — the
       * chosen source must have a move to this exact territory in the engine's
       * list (#204). Adjacency alone would re-derive half the rule here and take
       * the source's legality on trust from the earlier click; asking
       * getValidMoves keeps the click, the hints and the territory buttons'
       * names three readings of one list, with applyAction — whose throw lands
       * in the catch in executeAttack — as the backstop rather than the first
       * check.
       */
      const fromId = storeState.selectedFrom;
      const isValidTarget = getValidMoves(state).some(m => m.from === fromId && m.to === areaId);
      if (!isValidTarget) return;

      if (soundManager) soundManager.play('click');

      // Execute attack
      executeAttack(fromId, areaId);
    }
  }

  /**
   * Execute an attack action.
   * @param {number} fromId
   * @param {number} toId
   */
  async function executeAttack(fromId, toId) {
    // Block further input during animation
    store.setState({ awaitingInput: null });
    refreshCandidateHighlights(); // the offer is spent — take the candidates down

    const prevState = store.getState().gameState;

    let nextState;
    try {
      nextState = applyAction(prevState, {
        type: ACTION_TYPES.ATTACK,
        from: fromId,
        to: toId,
      });
    } catch (err) {
      console.warn('[GameController] Human attack failed, resetting selection:', err.message);
      // The engine refused the move, so the board goes back to offering sources
      // — the same three steps in the same order the player's own cancel runs,
      // shared rather than copied (`resetSelection` above). Not `cancelSelection`:
      // `awaitingInput` is already null here, which its guard rejects.
      resetSelection();
      return;
    }

    const lastAction = nextState.history[nextState.history.length - 1];
    const battleResult = lastAction ? lastAction.result : null;

    /*
     * Both seats, read from the board the attack was ROLLED on. The engine's
     * BattleResult is rolls and an outcome — no seats — and prevState is the
     * only place the DEFENDER's seat still stands: a won attack has already
     * handed the target to the attacker in nextState, which is what the store
     * publishes. The live region needs them to say whose attack this was and
     * whose territory was under it (#211 item 10); the dice animation has
     * always needed them for the two players' colors, and reads the same pair.
     *
     * Unguarded, like the AI loop's pair above: applyAction has just accepted
     * both ids on this very board, and applyAttack throws on an area that is
     * missing or off the board on either side — so a missing one here is a
     * torn state, and these values feed the dice hands' colors as well as the
     * spoken line. Falling back to null would hand the player a mis-coloured
     * roll and a bare battle line instead of a console error.
     */
    const atkOwner = prevState.areas[fromId].owner;
    const defOwner = prevState.areas[toId].owner;

    store.setState({
      gameState: nextState,
      battleResult: battleResult
        ? { ...battleResult, attacker: atkOwner, defender: defOwner }
        : null,
      animationPhase: 'battle',
      selectedTo: toId,
    });

    if (renderer) {
      renderer.hexGrid.setHighlight('to', toId);
      renderer.update(prevState, nextState);
    }

    // Play battle animation or brief delay
    if (renderer && renderer.battle && battleResult) {
      await renderer.battle.play(battleResult, atkOwner, defOwner);
    } else {
      await delay(400);
    }

    /*
     * Quitting mid-animation abandons this attack's aftermath too (#181):
     * goToTitle() has already cleared the board state, so re-arming input (or
     * showing game over) here would fire on the title screen.
     */
    if (store.getState().screen !== 'playing') return;

    if (soundManager && battleResult) {
      soundManager.play(battleResult.success ? 'success' : 'fail');
    }

    // Visual effects (non-blocking)
    if (renderer && battleResult && !isReducedMotion()) {
      if (battleResult.success) {
        try {
          const winColor = renderer.getPlayerColor(prevState.areas[fromId].owner);
          renderer.playParticleEffect(toId, winColor);
        } catch (err) {
          console.error('[GameController] Particle effect failed:', err);
        }
      }
      try {
        const totalDice = (prevState.areas[fromId]?.dice || 0) + (prevState.areas[toId]?.dice || 0);
        if (totalDice >= 10) renderer.screenShake(3, 200);
      } catch (err) {
        console.error('[GameController] Screen shake failed:', err);
      }
    }

    const isOver = nextState.phase === GAME_PHASES.GAME_OVER;
    store.setState({
      battleResult: null,
      animationPhase: 'idle',
      selectedFrom: null,
      selectedTo: null,
      awaitingInput: isOver ? null : 'selectFrom',
    });

    if (renderer) renderer.hexGrid.clearSelectionHighlights();
    refreshCandidateHighlights(); // re-arm the offer on the post-attack board

    if (isOver) await triggerGameOver(nextState);
  }

  /** Compute effective animation speed (aiSpeed * user preference). */
  function getEffectiveSpeed() {
    const s = store.getState();
    const aiSpeed = s.aiSpeed || 1;
    const prefSpeed = s.preferences?.animationSpeed || 1;
    return aiSpeed * prefSpeed;
  }

  /** Check if reduced motion is active. */
  function isReducedMotion() {
    if (preferencesManager) return preferencesManager.effectiveReducedMotion();
    // Fallback when no preferencesManager is provided (e.g. in tests)
    const prefs = store.getState().preferences;
    if (!prefs) return false;
    if (prefs.reducedMotion === 'on') return true;
    if (prefs.reducedMotion === 'off') return false;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      // matchMedia unavailable in SSR, test environments, or older browsers
      return false;
    }
  }

  /**
   * Handle game-over transition: determine if the human was eliminated
   * (vs. the game actually ending), build a replay for completed games,
   * optionally play a celebration, then show the gameOver screen.
   */
  async function triggerGameOver(state, { drawReason = null } = {}) {
    const humanIdx = store.getState().humanPlayerIndex;
    const humanEliminated =
      humanIdx !== null &&
      state.players[humanIdx]?.eliminated === true &&
      state.phase !== GAME_PHASES.GAME_OVER;

    /*
     * Build a replay for any game the player can meaningfully review: a completed game
     * (someone conquered the board) or a turn-cap draw (finished, if inconclusive). Skip
     * it only for a mid-game human elimination, where the game is still running for the
     * remaining AIs (phase stays 'playing', no drawReason).
     */
    const replay =
      state.phase === GAME_PHASES.GAME_OVER || drawReason ? buildGameReplay(state) : null;

    if (renderer && state.winner !== null && !isReducedMotion()) {
      try {
        await renderer.playCelebration(state.winner, state);
      } catch (err) {
        console.error('[GameController] Celebration animation failed:', err);
      }
    }
    /*
     * The celebration holds the playing screen for a full 1.5s, so QUIT/Escape
     * are live throughout it (#181). Claiming the screen for a game the player
     * has already walked away from would bounce them off the title screen — and
     * restore the abandoned game's state behind it. The screen is the test to
     * make, not `aiAborted`: that flag is only meaningful inside the AI loop —
     * every navigation (startNewGame included) sets it and only runAITurn
     * clears it, so on a human turn it holds a stale value (true until the
     * first AI turn has run) and would suppress legitimate game overs.
     */
    if (store.getState().screen !== 'playing') return;

    store.setState({
      gameState: state,
      screen: 'gameOver',
      currentReplay: replay,
      humanEliminated,
      gameOverReason: drawReason,
      /*
       * The playing screen is going away (#181): the dialog doesn't pause play,
       * so an AI can finish the game — or eliminate the human — while it is up.
       * Drop the flag here, or Spectate (which flips back to 'playing' without
       * touching it) would resurrect a stale dialog.
       */
      quitConfirmOpen: false,
      /*
       * The playing screen takes BoardFocus with it, and an element removed
       * while it holds focus fires no focusout in Firefox or jsdom — so the
       * mirror is closed here rather than left to a listener that may never
       * run (#211).
       */
      focusedAreaId: null,
    });
    /*
     * The renderer's half of the same seam — and since #211 item 3 it is the
     * ONLY half, on every route in. The two attack seams (the human's and the
     * AI loop's) run clearSelectionHighlights() on the way here, which
     * deliberately leaves the focus layer alone; the endTurn game-over branch
     * and the turn-cap draw clear nothing at all. So the ring comes off the
     * board behind the game-over card here, paired with the `focusedAreaId:
     * null` above, or not at all.
     *
     * Guarded like the other three unmount seams — startNewGame, startSpectate,
     * the endTurn error bounce — rather than on a bare `renderer` (#211 item 6):
     * `hexGrid` is null until init() succeeds, and which seams a board that
     * never came up can still reach is not something these four should each be
     * reasoned about separately.
     */
    if (renderer && renderer.hexGrid) renderer.hexGrid.clearFocusHighlight();
    if (soundManager) soundManager.play('over');
  }

  /** Navigate to replay viewer for the current game's replay. */
  function viewGameReplay() {
    const { currentReplay } = store.getState();
    if (currentReplay) {
      store.setState({ screen: 'replay', replayOrigin: 'gameOver' });
    }
  }

  /** Return from replay viewer to the screen that opened it. */
  function goBackFromReplay() {
    replayRenderedState = null;
    const { replayOrigin } = store.getState();
    if (replayOrigin === 'gameOver') {
      store.setState({ screen: 'gameOver', replayOrigin: null });
    } else {
      goToTitle();
    }
  }

  /**
   * Switch to spectate mode after human elimination: assign AI to
   * the human slot and return to the playing screen so the remaining
   * AI players finish the game.
   */
  async function startSpectate() {
    aiAborted = true; // stop any running AI loop

    const { gameState } = store.getState();
    if (!gameState || gameState.phase === GAME_PHASES.GAME_OVER) return;

    /*
     * Ensure every player slot has an AI function. playerNames is left alone on
     * purpose: the human's seat is eliminated (that is how we got here), so the
     * bot filling it never acts and can't win, and the replay's `bots` should
     * record the lineup as it was played — that seat was the human's.
     */
    for (let i = 0; i < aiFunctions.length; i++) {
      if (!aiFunctions[i]) {
        try {
          aiFunctions[i] = await getAIImplementation('ai_default');
        } catch (err) {
          console.error(`[GameController] Failed to load fallback AI for player ${i}:`, err);
          store.setState({ error: 'Could not start spectate mode: AI failed to load.' });
          return;
        }
      }
    }

    store.setState({
      screen: 'playing',
      humanPlayerIndex: null,
      humanEliminated: false,
      awaitingInput: null,
      error: null,
      // BoardFocus unmounts with the human seat, and that unmount is as silent
      // as the game-over one — so the mirror is closed here too (#211).
      focusedAreaId: null,
    });
    // Paired by construction — store id and ring in the same function — like
    // every other seam that nulls the id, not by what happened to run before
    // this one (#211). Guarded like the refreshCandidateHighlights() below:
    // `hexGrid` is null when init() failed.
    if (renderer && renderer.hexGrid) renderer.hexGrid.clearFocusHighlight();
    refreshCandidateHighlights(); // nobody to hint to once the seat is an AI's

    startTurn();
  }

  /**
   * Redraw the PixiJS canvas to reflect a given game state (used by the replay viewer).
   *
   * The first call for a replay draws the full map; consecutive steps of the
   * same game (same grid reference) diff against the last drawn state instead,
   * which redraws only the territories that changed owner rather than retracing
   * and rebuilding every territory's Graphics 16×/sec at 8x playback.
   */
  function updateReplayBoard(state) {
    if (renderer && state) {
      try {
        const prev = replayRenderedState;
        if (prev && prev.grid === state.grid) {
          renderer.update(prev, state);
        } else {
          renderer.drawMap(state);
        }
        replayRenderedState = state;
      } catch (err) {
        // A failed update() may leave the canvas mid-repaint; drop the cached
        // state so the next step takes the full-drawMap branch and recovers to
        // a consistent board instead of diffing against a stale reference.
        replayRenderedState = null;
        console.error('[GameController] Failed to render replay board:', err);
        throw new Error('Failed to render the game board for this replay step.', { cause: err });
      }
    }
  }

  /** End the human player's turn (called from the UI END TURN button). */
  function endHumanTurn() {
    const storeState = store.getState();
    if (storeState.awaitingInput === null) return;
    endTurn().catch(err => {
      console.error('[GameController] End turn failed:', err);
    });
  }

  /** Apply END_TURN action and advance to next player. */
  async function endTurn() {
    const prevState = store.getState().gameState;
    if (!prevState) return;

    // Snapshot dice counts before reinforcement
    const diceBefore = [];
    for (let a = 0; a < prevState.areas.length; a++) {
      diceBefore[a] = prevState.areas[a]?.dice ?? 0;
    }

    let nextState;
    try {
      nextState = applyAction(prevState, { type: ACTION_TYPES.END_TURN });
    } catch (err) {
      console.error('End turn action failed:', err);
      /*
       * Bouncing to the title has to leave the game as thoroughly stopped as a
       * deliberate quit does (#181): stop the AI loop, drop any pending
       * next-turn timer, and clear a confirm dialog raised over this game so it
       * can't be flagged open on the title screen (or in the next game).
       */
      aiAborted = true;
      clearNextTurnTimer();
      store.setState({
        screen: 'title',
        gameState: null,
        candidateAreas: null,
        quitConfirmOpen: false,
        rulesOpen: false,
        error: 'An error occurred. Returning to title screen.',
        // The lineup goes with the game, as on every other route to the title
        // (#211 item-3 addendum): no game is named behind a screen that has none.
        playerNames: [],
        /*
         * An unmount seam like goToTitle: the playing screen takes BoardFocus's
         * territory buttons with it, and a button removed while it holds focus
         * fires no event that can be relied on — so the mirror is closed here,
         * paired with the ring below (#211). E reaches this catch from a focused
         * territory, so it is a seam a keyboard player can actually hit.
         */
        focusedAreaId: null,
      });
      /*
       * The full wipe, which is what leaving the playing screen while nulling
       * the id in the same breath is for: it also takes down the from/to rings
       * and the hints this path left behind. `hexGrid` is null until init()
       * succeeds, hence goToTitle's guard shape.
       */
      if (renderer && renderer.hexGrid) renderer.hexGrid.clearHighlights();
      return;
    }

    // Compute reinforcement changes
    const changes = [];
    for (let a = 1; a < nextState.areas.length; a++) {
      const newDice = nextState.areas[a]?.dice ?? 0;
      if (newDice !== diceBefore[a]) {
        changes.push({ areaId: a, oldDice: diceBefore[a], newDice });
      }
    }

    store.setState({
      gameState: nextState,
      selectedFrom: null,
      selectedTo: null,
      awaitingInput: null,
      animationPhase: 'idle',
    });
    refreshCandidateHighlights(); // the turn is over — nothing left to offer

    // Update renderer, then animate reinforcements on top
    if (renderer && changes.length > 0 && !isReducedMotion()) {
      renderer.update(prevState, nextState);
      try {
        await renderer.animateReinforcements(changes);
      } catch (err) {
        console.error('[GameController] Reinforcement animation failed:', err);
      }
    } else if (renderer) {
      renderer.update(prevState, nextState);
    }

    /*
     * The reinforcement flash runs with animationPhase already back to 'idle',
     * so QUIT/Escape are live across it (#181). Everything below drives the game
     * forward — scheduling the next turn or ending it — which on the title
     * screen means a stray startTurn() with a null gameState, or a game-over
     * screen for a game the player abandoned. The screen is the test to make,
     * not `aiAborted` — that flag is stale outside the AI loop (see the note in
     * triggerGameOver), and a human END TURN lands here too.
     */
    if (store.getState().screen !== 'playing') return;

    if (nextState.phase === GAME_PHASES.GAME_OVER) {
      await triggerGameOver(nextState);
      return;
    }

    /*
     * Turn-cap draw. The engine never ends a game short of total conquest, so a stalled
     * AI-vs-AI board (leaders turtling behind maxed 8-dice borders) would loop forever.
     * On reaching MAX_GAME_TURNS with no winner, end it as a draw.
     */
    if (nextState.turnsTaken >= MAX_GAME_TURNS) {
      await triggerGameOver(nextState, { drawReason: 'turnLimit' });
      return;
    }

    // Small delay before next turn (cancelled by goToTitle if the player quits)
    clearNextTurnTimer();
    nextTurnTimer = setTimeout(() => {
      nextTurnTimer = null;
      startTurn();
    }, 100);
  }

  return {
    startNewGame,
    acceptMap,
    rejectMap,
    goToTitle,
    openQuitConfirm,
    closeQuitConfirm,
    openRules,
    closeRules,
    goToArena,
    goToTournament,
    goToOnlineLeaderboard,
    goToReplay,
    handleTerritoryClick,
    cancelSelection,
    endHumanTurn,
    refreshCandidateHighlights,
    viewGameReplay,
    goBackFromReplay,
    startSpectate,
    updateReplayBoard,
  };
}

/** Promise-based delay. */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
