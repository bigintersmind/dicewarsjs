/**
 * Keyboard Controller
 *
 * Provides keyboard navigation for the hex grid game board. Arrow keys move
 * focus between territories, Enter/Space confirms, Escape cancels a selection,
 * Tab steps through the player's own territories.
 *
 * Focus ownership (#201). The board is not a DOM element — its focus is the
 * virtual ring painted by `store.focusedAreaId` — so this listener sits on
 * `document` and would otherwise swallow keys aimed at real controls. It
 * therefore only claims the arrows, Enter/Space and Tab-cycling while DOM focus
 * is still on the board: `<body>`, the document element, or the canvas
 * (isBoardFocus). Once a button or the settings dropdown has focus, those keys
 * are left entirely alone so the browser activates the control natively.
 *
 * The board then behaves as one virtual tab stop sitting immediately before the
 * END TURN button, which gives the tab order: settings die → QUIT → RULES →
 * [own territories, ascending] → END TURN → out to the browser. Nothing wraps;
 * instead there are two seams into the DOM tab order, and two back:
 *
 *   - Tab past the last own territory clears the ring and focuses END TURN;
 *     Shift+Tab before the first focuses whatever precedes END TURN (RULES).
 *   - Shift+Tab on END TURN blurs it and re-enters the board on the LAST own
 *     territory; Tab on END TURN's predecessor re-enters on the first.
 *
 * When the seam's target is missing (no END TURN in the DOM, or nothing focusable
 * before it), the ring is still cleared but the key is left uncancelled so the
 * browser's own Tab-from-body runs — better a plain native tab than a dead key.
 *
 * Escape is shared with the quit-to-title confirm (#181): it cancels a
 * half-made attack when there is one, and is otherwise left uncancelled so
 * QuitConfirm's window-level handler — later in the bubble path — can raise
 * the "Abandon this game?" dialog. While that dialog is open the board takes
 * no keys at all. Unlike the rest, Escape is claimed wherever focus is: a
 * half-made attack has to be cancellable from a focused button too.
 *
 * @module controller/KeyboardController
 */

/**
 * DOM id of the END TURN button, the board's neighbor in the tab order.
 * Declared here because this module is what depends on finding it; GameOverlay
 * imports the constant rather than spelling the id twice.
 */
export const END_TURN_BUTTON_ID = 'dw-end-turn';

/** Everything the browser would stop at, for locating END TURN's neighbor. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Is DOM focus still on the board rather than on a real control?
 *
 * `<body>` is where focus sits for a player who has not tabbed into anything
 * yet (the playing screen deliberately places none — the #189 exception), and
 * where it is put back when a seam hands the board its focus again. The canvas
 * is not focusable, but a click on it can land focus there in some browsers.
 *
 * @param {Element|null} el - Typically document.activeElement
 * @returns {boolean}
 */
function isBoardFocus(el) {
  return !el || el === document.body || el === document.documentElement || el.id === 'pixi-canvas';
}

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

    const boardHasFocus = isBoardFocus(document.activeElement);

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!boardHasFocus) return;
        e.preventDefault();
        moveFocus(e.key, gameState, state);
        break;
      case 'Enter':
      case ' ':
        /*
         * A focused button gets its own Enter/Space: claiming them here would
         * both swallow the activation and fire an attack behind the dialog.
         */
        if (!boardHasFocus) return;
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
        handleTab(e, boardHasFocus, gameState, humanIdx, state);
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
   * Tab: step through own territories, or cross one of the seams (#201).
   *
   * @param {KeyboardEvent} e
   * @param {boolean} boardHasFocus - Whether the board still owns DOM focus
   */
  function handleTab(e, boardHasFocus, gameState, humanIdx, storeState) {
    const ownAreas = collectOwnAreas(gameState, humanIdx);
    if (!boardHasFocus) {
      enterBoard(e, ownAreas);
      return;
    }

    const currentIdx = ownAreas.indexOf(storeState.focusedAreaId);
    if (currentIdx < 0) {
      /*
       * Nothing highlighted: Tab enters at the first own territory, Shift+Tab
       * at the last — arriving backwards means arriving at the far end, the
       * same as a browser stepping back into a group of controls.
       */
      if (ownAreas.length === 0) {
        leaveBoard(e, e.shiftKey);
        return;
      }
      e.preventDefault();
      setFocus(e.shiftKey ? ownAreas[ownAreas.length - 1] : ownAreas[0]);
      return;
    }

    const nextIdx = e.shiftKey ? currentIdx - 1 : currentIdx + 1;
    // Past either end the board is done: hand off to the DOM rather than wrap.
    if (nextIdx < 0 || nextIdx >= ownAreas.length) {
      leaveBoard(e, e.shiftKey);
      return;
    }
    e.preventDefault();
    setFocus(ownAreas[nextIdx]);
  }

  /**
   * Hand DOM focus on: forward to END TURN, backward to whatever precedes it.
   * The ring is cleared either way; the key is only claimed when there is
   * actually somewhere to put focus, so a missing button degrades to a native
   * Tab out of `<body>` instead of a key that does nothing.
   */
  function leaveBoard(e, reverse) {
    const endTurn = document.getElementById(END_TURN_BUTTON_ID);
    const target = reverse ? focusablePredecessor(endTurn) : endTurn;
    clearBoardFocus();
    if (!target) return;
    e.preventDefault();
    target.focus();
  }

  /**
   * The two seams back onto the board: Shift+Tab from END TURN re-enters at the
   * last own territory, Tab from END TURN's predecessor at the first. Every
   * other control tabs natively.
   */
  function enterBoard(e, ownAreas) {
    if (ownAreas.length === 0) return;
    const endTurn = document.getElementById(END_TURN_BUTTON_ID);
    if (!endTurn) return;
    const active = document.activeElement;
    const target = e.shiftKey
      ? active === endTurn && ownAreas[ownAreas.length - 1]
      : active === focusablePredecessor(endTurn) && ownAreas[0];
    if (!target) return;
    e.preventDefault();
    // Focus goes back to <body>, which is what makes the board the owner again.
    active.blur?.();
    setFocus(target);
  }

  /**
   * The focusable element immediately before END TURN in document order.
   *
   * No visibility filtering: jsdom has no layout, and nothing on the playing
   * screen is a hidden focusable anyway — SettingsPanel renders its option
   * buttons only while the dropdown is open, so a closed dropdown contributes
   * just the die, and the HUD's centering twins are inert <span>s.
   *
   * @param {Element|null} endTurn
   * @returns {Element|null}
   */
  function focusablePredecessor(endTurn) {
    if (!endTurn) return null;
    const scope = document.getElementById('app') || document.body;
    const items = Array.from(scope.querySelectorAll(FOCUSABLE));
    const idx = items.indexOf(endTurn);
    return idx > 0 ? items[idx - 1] : null;
  }

  /** Collect the human's territories in ascending area id. */
  function collectOwnAreas(gameState, humanIdx) {
    const ownAreas = [];
    const areas = gameState.areas;
    for (let a = 1; a < (areas.length || Object.keys(areas).length + 1); a++) {
      if (areas[a] && areas[a].owner === humanIdx) {
        ownAreas.push(a);
      }
    }
    return ownAreas;
  }

  function setFocus(areaId) {
    store.setState({ focusedAreaId: areaId });
    if (renderer && renderer.hexGrid.setFocusHighlight) {
      renderer.hexGrid.setFocusHighlight(areaId);
    }
  }

  /** Take the ring down — the board no longer holds the keyboard's focus. */
  function clearBoardFocus() {
    store.setState({ focusedAreaId: null });
    renderer?.hexGrid?.clearFocusHighlight?.();
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
