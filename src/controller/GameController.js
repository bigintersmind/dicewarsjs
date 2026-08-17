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
import { resolveMapSize } from '../utils/config.js';

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
            `[GameController] Unknown AI id "${aiId}" for player ${i} — substituting ai_default.`
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
            `Player ${i + 1}: ${chosen} could not load — using ${fallbackName} instead.`
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
   */
  async function startNewGame(config) {
    aiAborted = true; // abort any running AI turn
    clearNextTurnTimer();
    store.setState({ error: null, aiLoadWarnings: [], playerNames: [] });

    if (!renderer) {
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
     * Update store config. Persist mapSize so a later rejectMap() regenerates
     * at the same size the player chose.
     */
    store.setState({
      config: { ...store.getState().config, playerCount, mapSize, aiAssignments, difficulty },
      humanPlayerIndex: spectator ? null : 0,
    });

    try {
      // Load AI functions
      const { fns, names, warnings } = await loadAIFunctions(playerCount, spectator);
      aiFunctions = fns;

      // Create game via engine
      const gameState = createGame({
        playerCount,
        ...resolveMapSize(mapSize),
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
        humanEliminated: false,
        gameOverReason: null,
        // No path may carry a previous game's open quit dialog into this one (#181).
        quitConfirmOpen: false,
        aiLoadWarnings: warnings,
        playerNames: names,
      });

      // Draw the map in the renderer
      if (renderer) {
        renderer.drawMap(gameState);
      }
    } catch (err) {
      console.error('Failed to start new game:', err);
      /*
       * This is a trip back to the title, so it has to leave the same state
       * goToTitle() would (#181) — a confirm dialog raised over the previous
       * game must not still be flagged open on the title screen. (aiAborted
       * and the next-turn timer were already dealt with on the way in.)
       */
      store.setState({
        screen: 'title',
        gameState: null,
        animationPhase: 'idle',
        awaitingInput: null,
        quitConfirmOpen: false,
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

    let gameState;
    try {
      gameState = createGame({
        playerCount,
        ...resolveMapSize(mapSize),
      });
    } catch (err) {
      console.error('Failed to regenerate map:', err);
      store.setState({
        screen: 'title',
        gameState: null,
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
      currentReplay: null,
      replayOrigin: null,
      humanEliminated: false,
      gameOverReason: null,
      quitConfirmOpen: false,
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
      if (soundManager) soundManager.play('myturn');
    } else {
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

      store.setState({
        gameState: state,
        battleResult,
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
        const atkOwner = prevState.areas[move.from].owner;
        const defOwner = prevState.areas[move.to].owner;
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
        if (renderer) renderer.hexGrid.clearHighlights();
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
        renderer.hexGrid.clearHighlights();
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
   * Handle a territory click during human turn.
   * @param {number} areaId
   */
  function handleTerritoryClick(areaId) {
    if (areaId === 0) return;

    const storeState = store.getState();
    const state = storeState.gameState;
    if (!state || storeState.screen !== 'playing') return;
    if (storeState.animationPhase !== 'idle') return;
    if (storeState.quitConfirmOpen) return; // the confirm dialog owns input while it is up

    const currentPlayerId = state.turnOrder[state.currentPlayerIndex];
    if (currentPlayerId !== storeState.humanPlayerIndex) return;

    const area = state.areas[areaId];
    if (!area) return;

    if (storeState.awaitingInput === 'selectFrom') {
      // Select attack source
      if (area.owner !== currentPlayerId) return;
      if (area.dice <= 1) return;

      store.setState({ selectedFrom: areaId, awaitingInput: 'selectTo' });
      if (renderer) {
        renderer.hexGrid.clearHighlights();
        renderer.hexGrid.setHighlight('from', areaId);
      }
      if (soundManager) soundManager.play('click');
    } else if (storeState.awaitingInput === 'selectTo') {
      // If clicking own territory again, reselect
      if (area.owner === currentPlayerId) {
        if (area.dice <= 1) return;
        store.setState({ selectedFrom: areaId, awaitingInput: 'selectTo' });
        if (renderer) {
          renderer.hexGrid.clearHighlights();
          renderer.hexGrid.setHighlight('from', areaId);
        }
        if (soundManager) soundManager.play('click');
        return;
      }

      // Validate attack target
      const fromId = storeState.selectedFrom;
      const fromArea = state.areas[fromId];
      if (!fromArea) return;

      const isAdjacent = fromArea.neighborAreaIds.includes(areaId);
      if (!isAdjacent) return;

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
      // Invalid move — reset selection
      store.setState({
        selectedFrom: null,
        selectedTo: null,
        awaitingInput: 'selectFrom',
      });
      if (renderer) renderer.hexGrid.clearHighlights();
      return;
    }

    const lastAction = nextState.history[nextState.history.length - 1];
    const battleResult = lastAction ? lastAction.result : null;

    store.setState({
      gameState: nextState,
      battleResult,
      animationPhase: 'battle',
      selectedTo: toId,
    });

    if (renderer) {
      renderer.hexGrid.setHighlight('to', toId);
      renderer.update(prevState, nextState);
    }

    // Play battle animation or brief delay
    if (renderer && renderer.battle && battleResult) {
      const atkOwner = prevState.areas[fromId].owner;
      const defOwner = prevState.areas[toId].owner;
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

    if (renderer) renderer.hexGrid.clearHighlights();

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
    });
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
    });

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
        quitConfirmOpen: false,
        error: 'An error occurred. Returning to title screen.',
      });
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
    goToArena,
    goToTournament,
    goToOnlineLeaderboard,
    goToReplay,
    handleTerritoryClick,
    endHumanTurn,
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
