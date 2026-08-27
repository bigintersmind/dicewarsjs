/**
 * Keyboard Controller
 *
 * Provides keyboard navigation for the hex grid game board. Arrow keys move
 * focus between territories, Enter/Space confirms, Escape cancels a selection,
 * Tab steps through the player's own territories, and E ends the turn.
 *
 * Focus ownership (#201). The board is not a DOM element — its focus is the
 * virtual ring painted by `store.focusedAreaId` — so this listener sits on
 * `document` and would otherwise swallow keys aimed at real controls. It
 * therefore only claims the arrows, Enter/Space and Tab-stepping while DOM
 * focus is still on the board: `<body>`, the document element, or the canvas
 * (isBoardFocus). Once a button or the settings dropdown has focus, the arrows
 * and Enter/Space are left entirely alone so the browser activates the control
 * natively. Tab is still watched from a focused control, because two of its
 * presses are the seams back onto the board (below), and E has its own, looser
 * rule (further below). A `focusin` listener rounds it off: whenever DOM focus
 * lands on a real control the ring comes down, because focus can leave the
 * board without crossing a seam at all.
 *
 * The board then behaves as one virtual tab stop sitting immediately before the
 * END TURN button, which gives the tab order: settings die → QUIT → RULES →
 * [own territories, ascending] → END TURN → out to the browser. That is the
 * walk when focus enters from the browser's chrome; on a fresh playing screen
 * DOM focus is already on `<body>` — the board — so the very first Tab is a
 * step onto the first own territory, and the die, QUIT and RULES are a
 * Shift+Tab away rather than ahead. Nothing wraps; instead there are two seams
 * into the DOM tab order, and two back:
 *
 *   - Tab past the last own territory clears the ring and focuses END TURN;
 *     Shift+Tab before the first focuses whatever precedes END TURN (RULES).
 *   - Shift+Tab on END TURN blurs it and re-enters the board on the LAST own
 *     territory; Tab on END TURN's predecessor re-enters on the first.
 *
 * When the seam's target is missing (no END TURN in the DOM, or nothing focusable
 * before it) or refuses focus, the ring is still cleared but the key is left
 * uncancelled so the browser's own Tab-from-body runs — better a plain native
 * tab than a dead key.
 *
 * E is the shortcut past all of that: Tab reaches END TURN one territory at a
 * time, which is 20-odd presses mid-game for the one thing every turn ends
 * with. It fires from the board and from any focused button or link — none of
 * them consume letters, and END TURN advertises the key through
 * `aria-keyshortcuts`, so it has to work on the very control that announces it
 * — but never from a text-entry control (isTextEntry: input, select, textarea,
 * contenteditable), which owns its own letters, and never with a modifier
 * held, so it never shadows a browser shortcut. Tab remains the route a screen
 * reader can rely on: NVDA and JAWS swallow single letters in browse mode,
 * where E is "next form field".
 *
 * Escape is shared with the quit-to-title confirm (#181). Unlike the rest it is
 * *handled* wherever focus is — a half-made attack has to be cancellable from a
 * focused button too — but it is only *claimed* when it actually cancelled one;
 * an uncancelled Escape is what QuitConfirm's window-level handler, later in the
 * bubble path, listens for to raise "Abandon this game?". While that dialog or
 * the "How to play" card is open the board takes no keys at all.
 *
 * Two behaviours that read as bugs and are not:
 *
 *   - After a MOUSE click on QUIT → KEEP PLAYING, QuitConfirm restores focus to
 *     the QUIT button, so the arrows are dead until a click on the board or a
 *     Tab moves focus off it. That is native button semantics; the focusin rule
 *     has already taken the ring down, so nothing is left pointing at a
 *     territory the keys cannot reach.
 *   - Tab during a battle animation goes native — the whole handler bails while
 *     `animationPhase` is not idle. Swallowing it for the animation's duration
 *     would be a brief keyboard trap.
 *
 * @module controller/KeyboardController
 */

/**
 * DOM id of the END TURN button, the board's neighbor in the tab order.
 * Declared here because this module is what depends on finding it; GameOverlay
 * imports the constant rather than spelling the id twice — a ui → controller
 * import, which is safe only because this module is a constant plus a factory
 * with no import-time side effects.
 */
export const END_TURN_BUTTON_ID = 'dw-end-turn';

/**
 * The usual tab-stop approximation, for locating END TURN's neighbor. Not
 * everything the browser would stop at: it misses <summary>, contenteditable
 * and media with controls, and over-matches hidden inputs — none of which the
 * playing screen has.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Is DOM focus still on the board rather than on a real control?
 *
 * `<body>` is where focus sits for a player who has not tabbed into anything
 * yet (the playing screen deliberately places none — the #189 exception), and
 * where it is put back when a seam hands the board its focus again. The canvas
 * carries no tabindex and nothing calls focus() on it, so today it never holds
 * focus; it is listed defensively, so that adding a tabindex — or Pixi's
 * accessibility layer, which renders its own div — cannot silently kill every
 * board key. The 'pixi-canvas' literal is duplicated from index.html and
 * main.jsx; there is no shared constant for it.
 *
 * @param {Element|null} el - Typically document.activeElement
 * @returns {boolean}
 */
function isBoardFocus(el) {
  return !el || el === document.body || el === document.documentElement || el.id === 'pixi-canvas';
}

/**
 * Controls that consume typed letters themselves — the only places E must stay
 * theirs. Buttons and links do not, so E works from them; see the header.
 * (jsdom leaves `isContentEditable` undefined, hence the strict comparison.)
 */
function isTextEntry(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
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
  let warnedNoSeamTarget = false;

  /**
   * One-shot: the seams are broken, and broken for good.
   *
   * A null lookup while the store says playing + human turn is never transient
   * — GameStore notifies synchronously and Preact flushes on a microtask, well
   * before the next input event — so it means the id contract broke or an
   * ErrorBoundary is showing its fallback where the overlay should be. Warn
   * once rather than on every Tab.
   */
  function warnNoSeamTarget() {
    if (warnedNoSeamTarget) return;
    warnedNoSeamTarget = true;
    console.warn(
      '[KeyboardController] END TURN button (#dw-end-turn) not found or not focusable — that Tab was left to the browser'
    );
  }

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
      case 'e':
      case 'E':
        /*
         * The one-key way out of a turn, so ending it does not cost a Tab per
         * territory. Looser than the arrows' ownership rule: a focused button
         * or link does nothing with a letter, and END TURN itself advertises E
         * via aria-keyshortcuts, so only a text-entry control keeps the key.
         * No modifier, so Ctrl/Cmd/Alt+E stay the browser's. endHumanTurn()
         * no-ops when awaitingInput is null, which is the guard against ending
         * a turn the player is not actually taking.
         */
        if (isTextEntry(document.activeElement)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        controller.endHumanTurn();
        break;
      case 'Escape':
        /*
         * Handled wherever focus is, but only claimed when there was actually a
         * selection to cancel; an uncancelled Escape is what QuitConfirm
         * listens for (#181).
         */
        if (cancelSelection()) e.preventDefault();
        break;
      case 'Tab':
        handleTab(e, boardHasFocus, gameState, humanIdx, state);
        break;
    }
  }

  /**
   * Keep the ring honest when focus leaves the board without a seam.
   *
   * Three ways that happens, none of them going through handleTab: a mouse
   * click on QUIT / RULES / the settings die; a native Tab taken while this
   * handler was bailing (a battle animation, an AI turn); and QuitConfirm or
   * RulesModal restoring focus to whatever opened them on close. Left alone,
   * the ring stays painted on a territory the keys no longer reach — and Enter
   * would then act on the focused button instead.
   *
   * Idempotent with leaveBoard, which has already cleared the ring by the time
   * its focus() fires this, and never triggered by enterBoard, which blurs to
   * `<body>` rather than focusing a control.
   */
  function handleFocusIn(e) {
    const state = store.getState();
    if (state.screen !== 'playing') return;
    if (isBoardFocus(e.target)) return;
    if (state.focusedAreaId == null) return;
    clearBoardFocus();
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
     * The selection and the keyboard's focus are different things, and
     * clearHighlights() wipes both layers — but only the selection was
     * cancelled, so repaint the ring where it still is. Without this the next
     * Tab steps on from an invisible position.
     */
    if (renderer && storeState.focusedAreaId != null) {
      renderer.hexGrid.setFocusHighlight(storeState.focusedAreaId);
    }
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
   *
   * The ring is cleared either way; the key is only claimed once focus has
   * actually landed on the target. Checking after the fact rather than trusting
   * focus() is what keeps a disabled END TURN from becoming a dead key — the
   * predecessor lookup filters `disabled` out, but getElementById does not — and
   * a native Tab out of `<body>` is a far better failure than nowhere to go.
   */
  function leaveBoard(e, reverse) {
    const endTurn = document.getElementById(END_TURN_BUTTON_ID);
    if (!endTurn && !reverse) warnNoSeamTarget();
    const target = reverse ? focusablePredecessor(endTurn) : endTurn;
    clearBoardFocus();
    // A missing predecessor is legitimate: END TURN can be the first focusable.
    if (!target) return;
    target.focus();
    if (document.activeElement === target) {
      e.preventDefault();
    } else {
      warnNoSeamTarget();
    }
  }

  /**
   * The two seams back onto the board: Shift+Tab from END TURN re-enters at the
   * last own territory, Tab from END TURN's predecessor at the first. Every
   * other control tabs natively.
   */
  function enterBoard(e, ownAreas) {
    if (ownAreas.length === 0) return;
    const endTurn = document.getElementById(END_TURN_BUTTON_ID);
    if (!endTurn) {
      warnNoSeamTarget();
      return;
    }
    // Never null here: isBoardFocus() treats a null activeElement as the board,
    // so a null one would have been handled as a step, not as an entry.
    const active = document.activeElement;
    const target = e.shiftKey
      ? active === endTurn && ownAreas[ownAreas.length - 1]
      : active === focusablePredecessor(endTurn) && ownAreas[0];
    if (!target) return;
    e.preventDefault();
    // Focus goes back to <body>, which is what makes the board the owner again.
    active.blur();
    setFocus(target);
  }

  /**
   * The focusable element immediately before END TURN in document order.
   *
   * No visibility filtering: jsdom has no layout, and nothing on the playing
   * screen is a hidden focusable anyway — SettingsPanel renders its option
   * buttons only while the dropdown is open, so a closed dropdown contributes
   * just the die, and the HUD's centering twins are non-focusable <span>s.
   *
   * Computed live on every press rather than cached, because an open dropdown
   * genuinely adds focusables (its option buttons and the "Source on GitHub"
   * link). They all sit before QUIT in document order, so the answer stays
   * RULES either way — but only because it is recomputed, not assumed.
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
    if (renderer) renderer.hexGrid.clearFocusHighlight();
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
  document.addEventListener('focusin', handleFocusIn);

  return {
    destroy() {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
    },
  };
}
