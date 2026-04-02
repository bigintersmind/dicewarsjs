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
import { getAIImplementation } from '../ai/aiConfig.js';
import { createReplayFromState } from '../arena/replayFormat.js';
import { DEFAULT_CONFIG } from '../utils/config.js';

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

  /**
   * Build AI assignment array from config.
   * @param {number} playerCount
   * @param {boolean} spectator
   */
  async function loadAIFunctions(playerCount, spectator) {
    const storeState = store.getState();
    const assignments = [...storeState.config.aiAssignments].slice(0, playerCount);

    // In spectator mode, all players are AI
    if (spectator) {
      for (let i = 0; i < assignments.length; i++) {
        if (!assignments[i]) assignments[i] = 'ai_default';
      }
    }

    const fns = [];
    for (let i = 0; i < playerCount; i++) {
      const aiId = assignments[i];
      if (!aiId) {
        fns.push(null); // human
      } else {
        try {
          fns.push(await getAIImplementation(aiId));
        } catch (err) {
          console.error(
            `Failed to load AI "${aiId}" for player ${i}, falling back to ai_default:`,
            err
          );
          try {
            fns.push(await getAIImplementation('ai_default'));
          } catch (fallbackErr) {
            throw new Error(
              `Cannot load any AI for player ${i}: both "${aiId}" and "ai_default" failed`
            );
          }
        }
      }
    }
    return fns;
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
      const humanIdx = store.getState().humanPlayerIndex;
      const playerCount = state.config.playerCount;
      const bots = [];
      for (let i = 0; i < playerCount; i++) {
        bots.push(i === humanIdx ? 'You' : `AI ${i + 1}`);
      }
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
   * @param {{ playerCount: number, spectator: boolean }} config
   */
  async function startNewGame(config) {
    aiAborted = true; // abort any running AI turn
    store.setState({ error: null });

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

    // Update store config
    store.setState({
      config: { ...store.getState().config, playerCount },
      humanPlayerIndex: spectator ? null : 0,
    });

    try {
      // Load AI functions
      aiFunctions = await loadAIFunctions(playerCount, spectator);

      // Create game via engine
      const gameState = createGame({
        playerCount,
        mapWidth: DEFAULT_CONFIG.mapWidth,
        mapHeight: DEFAULT_CONFIG.mapHeight,
        maxAreas: DEFAULT_CONFIG.territoriesCount,
      });

      store.setState({
        gameState,
        screen: 'mapPreview',
        selectedFrom: null,
        selectedTo: null,
        battleResult: null,
        animationPhase: 'idle',
        awaitingInput: null,
        humanEliminated: false,
      });

      // Draw the map in the renderer
      if (renderer) {
        renderer.drawMap(gameState);
      }
    } catch (err) {
      console.error('Failed to start new game:', err);
      store.setState({
        screen: 'title',
        gameState: null,
        animationPhase: 'idle',
        awaitingInput: null,
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

    let gameState;
    try {
      gameState = createGame({
        playerCount,
        mapWidth: DEFAULT_CONFIG.mapWidth,
        mapHeight: DEFAULT_CONFIG.mapHeight,
        maxAreas: DEFAULT_CONFIG.territoriesCount,
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

  /** Go back to the title screen. */
  function goToTitle() {
    aiAborted = true;
    store.setState({
      screen: 'title',
      gameState: null,
      selectedFrom: null,
      selectedTo: null,
      battleResult: null,
      animationPhase: 'idle',
      awaitingInput: null,
      currentReplay: null,
      replayOrigin: null,
      humanEliminated: false,
    });
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

    if (!aiAborted && state && state.phase !== GAME_PHASES.GAME_OVER) {
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
  async function triggerGameOver(state) {
    const humanIdx = store.getState().humanPlayerIndex;
    const humanEliminated =
      humanIdx !== null &&
      state.players[humanIdx]?.eliminated === true &&
      state.phase !== GAME_PHASES.GAME_OVER;

    // Only build replay for completed games (not partial on human elimination)
    const replay = state.phase === GAME_PHASES.GAME_OVER ? buildGameReplay(state) : null;

    if (renderer && state.winner !== null && !isReducedMotion()) {
      try {
        await renderer.playCelebration(state.winner, state);
      } catch (err) {
        console.error('[GameController] Celebration animation failed:', err);
      }
    }
    store.setState({
      gameState: state,
      screen: 'gameOver',
      currentReplay: replay,
      humanEliminated,
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

    // Ensure every player slot has an AI function
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

  /** Redraw the PixiJS canvas to reflect a given game state (used by the replay viewer). */
  function updateReplayBoard(state) {
    if (renderer && state) {
      try {
        renderer.drawMap(state);
      } catch (err) {
        console.error('[GameController] Failed to render replay board:', err);
        throw new Error('Failed to render the game board for this replay step.');
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
      store.setState({
        screen: 'title',
        gameState: null,
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

    if (nextState.phase === GAME_PHASES.GAME_OVER) {
      await triggerGameOver(nextState);
      return;
    }

    // Small delay before next turn
    setTimeout(() => startTurn(), 100);
  }

  return {
    startNewGame,
    acceptMap,
    rejectMap,
    goToTitle,
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
