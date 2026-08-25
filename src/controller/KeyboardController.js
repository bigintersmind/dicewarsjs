/**
 * Keyboard Controller
 *
 * Provides keyboard navigation for the hex grid game board.
 * Arrow keys move focus between territories, Enter/Space confirms,
 * Escape cancels selection, Tab cycles own territories.
 *
 * Escape is shared with the quit-to-title confirm (#181): it cancels a
 * half-made attack when there is one, and is otherwise left uncancelled so
 * QuitConfirm's window-level handler — later in the bubble path — can raise
 * the "Abandon this game?" dialog. While that dialog is open the board takes
 * no keys at all.
 *
 * @module controller/KeyboardController
 */

/**
 * Create a keyboard controller for hex grid navigation.
 *
 * @param {Object} store - GameStore instance
 * @param {Object} controller - GameController instance
 * @param {import('../renderer/GameRenderer.js').GameRenderer | null} renderer
 * @returns {{ destroy: () => void }}
 */
export function createKeyboardController(store, controller, renderer) {
  let warnedNoCellPos = false;

  function handleKeyDown(e) {
    const state = store.getState();
    if (state.screen !== 'playing') return;
    /*
     * The quit confirm and the "How to play" card are modal: board navigation
     * is suspended, and Escape passes through untouched so the open dialog's
     * own handler can close it.
     */
    if (state.quitConfirmOpen || state.rulesOpen) return;
    if (state.animationPhase !== 'idle') return;

    const humanIdx = state.humanPlayerIndex;
    if (humanIdx === null) return;

    const gameState = state.gameState;
    if (!gameState) return;

    const currentPlayerId = gameState.turnOrder[gameState.currentPlayerIndex];
    if (currentPlayerId !== humanIdx) return;

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault();
        moveFocus(e.key, gameState, state);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        confirmFocus(state);
        break;
      case 'Escape':
        /*
         * Only claim the key when there was actually a selection to cancel;
         * an uncancelled Escape is what QuitConfirm listens for (#181).
         */
        if (cancelSelection()) e.preventDefault();
        break;
      case 'Tab':
        e.preventDefault();
        cycleTerritories(e.shiftKey, gameState, humanIdx, state);
        break;
    }
  }

  /**
   * Move focus to the neighbor closest to the given direction.
   */
  function moveFocus(key, gameState, storeState) {
    const focused = storeState.focusedAreaId;
    if (!focused) {
      // No focus yet — focus on first own territory
      const firstOwn = findFirstOwnTerritory(gameState, storeState.humanPlayerIndex);
      if (firstOwn) setFocus(firstOwn);
      return;
    }

    const area = gameState.areas[focused];
    if (!area || !area.neighborAreaIds) return;

    // Map arrow key to angle (degrees, screen-space: 0=right, 90=down)
    const angles = {
      ArrowRight: 0,
      ArrowDown: 90,
      ArrowUp: 270,
      ArrowLeft: 180,
    };
    const targetAngle = (angles[key] * Math.PI) / 180;

    // Find the neighbor closest to the desired direction
    const cellPos = renderer?.hexGrid?._cellPos;
    if (!cellPos) {
      if (!warnedNoCellPos) {
        console.warn('[KeyboardController] Cannot navigate: renderer cellPos not available');
        warnedNoCellPos = true;
      }
      return;
    }

    const focusCenter = getCellCenter(area.centerCell, cellPos);
    let bestNeighbor = null;
    let bestScore = Infinity;

    for (const nId of area.neighborAreaIds) {
      const neighbor = gameState.areas[nId];
      if (!neighbor) continue;
      const neighborCenter = getCellCenter(neighbor.centerCell, cellPos);
      const angle = Math.atan2(neighborCenter.y - focusCenter.y, neighborCenter.x - focusCenter.x);
      const diff = angleDiff(angle, targetAngle);
      if (diff < bestScore) {
        bestScore = diff;
        bestNeighbor = nId;
      }
    }

    if (bestNeighbor !== null) setFocus(bestNeighbor);
  }

  /**
   * Confirm the focused territory (acts like a click).
   */
  function confirmFocus(storeState) {
    const focused = storeState.focusedAreaId;
    if (!focused) return;
    controller.handleTerritoryClick(focused);
  }

  /**
   * Cancel current selection and return to selectFrom.
   *
   * @returns {boolean} True when a half-made attack was actually cancelled.
   */
  function cancelSelection() {
    const storeState = store.getState();
    if (storeState.awaitingInput !== 'selectTo') return false;
    store.setState({
      selectedFrom: null,
      awaitingInput: 'selectFrom',
    });
    if (renderer) renderer.hexGrid.clearHighlights();
    /*
     * clearHighlights() takes the board hints down with the selection, and this
     * is a return to selectFrom — so hand back to the controller, which owns
     * that mapping, to repaint the attack candidates.
     */
    controller.refreshCandidateHighlights();
    return true;
  }

  /**
   * Cycle focus through own territories.
   */
  function cycleTerritories(reverse, gameState, humanIdx, storeState) {
    const ownAreas = [];
    const areas = gameState.areas;
    for (let a = 1; a < (areas.length || Object.keys(areas).length + 1); a++) {
      if (areas[a] && areas[a].owner === humanIdx) {
        ownAreas.push(a);
      }
    }
    if (ownAreas.length === 0) return;

    const currentIdx = ownAreas.indexOf(storeState.focusedAreaId);
    let nextIdx;
    if (currentIdx < 0) {
      nextIdx = 0;
    } else if (reverse) {
      nextIdx = (currentIdx - 1 + ownAreas.length) % ownAreas.length;
    } else {
      nextIdx = (currentIdx + 1) % ownAreas.length;
    }

    setFocus(ownAreas[nextIdx]);
  }

  function setFocus(areaId) {
    store.setState({ focusedAreaId: areaId });
    if (renderer && renderer.hexGrid.setFocusHighlight) {
      renderer.hexGrid.setFocusHighlight(areaId);
    }
  }

  function findFirstOwnTerritory(gameState, humanIdx) {
    const areas = gameState.areas;
    for (let a = 1; a < (areas.length || Object.keys(areas).length + 1); a++) {
      if (areas[a] && areas[a].owner === humanIdx) return a;
    }
    return null;
  }

  function getCellCenter(cellIndex, cellPos) {
    return {
      x: cellPos.x[cellIndex] + 13, // half cell width
      y: cellPos.y[cellIndex] + 9, // half cell height
    };
  }

  function angleDiff(a, b) {
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  document.addEventListener('keydown', handleKeyDown);

  return {
    destroy() {
      document.removeEventListener('keydown', handleKeyDown);
    },
  };
}
