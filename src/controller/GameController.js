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
import { DEFAULT_CONFIG } from '../utils/config.js';

/**
 * Create a game controller.
 *
 * @param {Object} store - GameStore instance from createGameStore()
 * @param {import('../renderer/GameRenderer.js').GameRenderer | null} renderer
 * @param {Object | null} soundManager - Optional sound manager
 * @returns {Object} GameController public API
 */
export function createGameController(store, renderer, soundManager) {
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
          const atkColor = renderer.hexGrid._getPlayerColor(prevState.areas[move.from].owner);
          renderer.playParticleEffect(move.to, atkColor);
        }
        const atkDice = prevState.areas[move.from]?.dice || 0;
        const defDice = prevState.areas[move.to]?.dice || 0;
        const totalDice = atkDice + defDice;
        if (totalDice >= 10) renderer.screenShake(3, 200);
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

      // Check if game is over
      if (state.phase === GAME_PHASES.GAME_OVER) break;
    }

    if (!aiAborted && state && state.phase !== GAME_PHASES.GAME_OVER) {
      endTurn();
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
      // Particle burst on successful capture
      if (battleResult.success) {
        const winColor = renderer.hexGrid._getPlayerColor(prevState.areas[fromId].owner);
        renderer.playParticleEffect(toId, winColor);
      }

      // Screen shake on large battles
      const totalDice = (prevState.areas[fromId]?.dice || 0) + (prevState.areas[toId]?.dice || 0);
      if (totalDice >= 10) renderer.screenShake(3, 200);
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
    const prefs = store.getState().preferences;
    if (!prefs) return false;
    if (prefs.reducedMotion === 'on') return true;
    if (prefs.reducedMotion === 'off') return false;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /** Handle game-over transition with optional celebration. */
  async function triggerGameOver(state) {
    if (renderer && state.winner !== null && !isReducedMotion()) {
      await renderer.playCelebration(state.winner, state);
    }
    store.setState({ gameState: state, screen: 'gameOver' });
    if (soundManager) soundManager.play('over');
  }

  /** End the human player's turn (called from the UI END TURN button). */
  function endHumanTurn() {
    const storeState = store.getState();
    if (storeState.awaitingInput === null) return;
    return endTurn();
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

    // Animate reinforcements before updating renderer
    if (renderer && changes.length > 0 && !isReducedMotion()) {
      renderer.update(prevState, nextState);
      await renderer.animateReinforcements(changes);
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
    goToReplay,
    handleTerritoryClick,
    endHumanTurn,
  };
}

/** Promise-based delay. */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
