/**
 * Keyboard Controller
 *
 * The board's keyboard behaviour that is not already native: arrow keys move
 * focus between neighboring territories, Escape cancels a half-made attack, and
 * E ends the turn.
 *
 * Everything else is the browser's, because since #211 the board IS real DOM.
 * `BoardFocus` renders one visually hidden `<button>` per live territory, and
 * App renders it between GameHUD and GameOverlay, so document order is the tab
 * order — settings die → QUIT → RULES → own territories ascending → END TURN —
 * and Tab simply walks it. Enter and Space are the focused button's own
 * activation, whose click reaches `handleTerritoryClick` the same way a canvas
 * click does. Neither key is touched here.
 *
 * `store.focusedAreaId` is therefore a mirror of DOM focus rather than a
 * position of its own: the `focusin` listener writes the id and paints the
 * renderer's focus ring whenever a territory button takes focus, and `focusout`
 * (or a `focusin` on any other control) nulls it and takes the ring down. Every
 * way focus can move — a Tab, an arrow, a mouse click on a control, a dialog
 * restoring focus to what opened it, the window losing focus — reaches the ring
 * by that one path, so the ring cannot point somewhere focus is not. The arrow
 * handler moves DOM focus and lets the listeners do the bookkeeping.
 *
 * Nor can the ring be missing while the id is set (#211 item 3): the focus layer
 * is written only by `setFocus`/`clearBoardFocus` here and by GameController's
 * seams — game over, spectate, quit to title, the end-turn error bounce, and
 * game start defensively — each of which nulls the id and takes the ring down in
 * the same function, while every mid-game clear goes through
 * `clearSelectionHighlights()`, which leaves that layer alone. So the ring is
 * visible exactly when `focusedAreaId` is set (the one theoretical exception is
 * a territory with no traced border, where `setFocusHighlight` paints nothing —
 * a no-op that warns since item 4, so it can no longer pass for a ring that was
 * simply not asked for — and which is unreachable anyway while BoardFocus and
 * drawMap agree on what a live territory is). Which means a focus parked on a
 * territory through an AI turn — E pressed, or END TURN clicked on macOS Safari
 * or Firefox, where a click does not move focus — keeps its ring for the whole
 * turn, whoever ends up owning that territory, because that is where the next
 * arrow steps from. It is a cursor, not a selection.
 *
 * The listener sits on `document` and would otherwise swallow keys aimed at real
 * controls, so the arrows are claimed in exactly two situations: focus is on a
 * territory button (move to the neighbor in that direction), or focus is nowhere
 * — `<body>` or the document element, where a fresh playing screen leaves it,
 * since that screen deliberately places no focus (the #189 exception) — in which
 * case the first arrow enters the board at the first own territory. On any other
 * focused control the arrows are left entirely alone: they are the browser's
 * there (scrolling, a select, a radio group).
 *
 * The group is `role="application"` for this to work under a screen reader at
 * all: NVDA and JAWS default to browse mode, where the arrows move their own
 * virtual cursor and single letters are quick-nav commands, and neither
 * normally reaches a keydown listener. `application` hands both back to the
 * page — which is also what lets E through, where browse mode would have spent
 * it on "next form field".
 *
 * E is the shortcut past the tab walk: Tab reaches END TURN one territory at a
 * time — one press per territory — for the one thing every turn ends with. It
 * fires from the board and from any focused button or link — none of them
 * consume letters, and END TURN advertises the key through `aria-keyshortcuts`,
 * so it has to work on the very control that announces it — but never from a
 * text-entry control (isTextEntry: input, select, textarea, contenteditable),
 * which owns its own letters, and never with a modifier held, so it never
 * shadows a browser shortcut.
 *
 * Escape is shared with the quit-to-title confirm (#181). Unlike the rest it is
 * *handled* wherever focus is — a half-made attack has to be cancellable from a
 * focused button too — but it is only *claimed* when it actually cancelled one;
 * an uncancelled Escape is what QuitConfirm's window-level handler, later in the
 * bubble path, listens for to raise "Abandon this game?". While that dialog or
 * the "How to play" card is open the board takes no keys at all.
 *
 * Four behaviours that read as bugs and are not:
 *
 *   - After a MOUSE click on QUIT → KEEP PLAYING, QuitConfirm restores focus to
 *     the QUIT button — that is where focus came from, on browsers that focus a
 *     button on click — so the arrows are dead until Tab or a click moves focus
 *     off it. Native button semantics; the focus listeners have already taken
 *     the ring down, so nothing is left pointing at a territory the keys cannot
 *     reach. Safari (and Firefox on macOS) does not focus a clicked button, and
 *     there the restore lands on `<body>`, from which the next arrow enters the
 *     board. Opened from the KEYBOARD with focus on a territory, the same
 *     restore lands back on that territory button, ring and all.
 *   - Tab during a battle animation is native, and now by construction: this
 *     handler never sees Tab at all. The arrows, E and Escape do bail while
 *     `animationPhase` is not idle.
 *   - A click on a territory moves the keyboard with it: main.jsx hands the
 *     canvas `pointerdown` to `focusFromPointer` below, which — only when the
 *     board already holds focus — focuses that territory's button and lets the
 *     caller suppress mousedown's focus fixup, the thing that would otherwise
 *     have blurred the board to `<body>` and sent the next arrow back to the
 *     first own territory. That is what makes mixed use work: select the source
 *     with Enter, click the target with the mouse, and the ring is on the target
 *     — which after a win is yours. A click on WATER is deliberately still the
 *     browser's: focus drops to `<body>` and the ring comes down, because a
 *     click on nothing is as good a way as any to say "done with the keyboard
 *     position". A mouse-only player never acquires a ring from any of this.
 *   - Safari with "Press Tab to highlight each item" off (the pre-Sonoma
 *     default) does not visit `<button>`s on Tab at all, so the Tab route to the
 *     board and on to END TURN is Safari's to withhold. The arrows still enter
 *     from `<body>`, `focusArea`'s `focus()` is unaffected, and E fires from
 *     anywhere, so the game stays playable there. (#201's handler-driven Tab was
 *     immune to that preference; this is the price of the native walk.)
 *
 * @module controller/KeyboardController
 */

/**
 * Prefix of the DOM id BoardFocus gives each territory button. Declared here
 * because this module is what depends on finding those buttons and on reading
 * an id back off a focus event; BoardFocus imports the builder rather than
 * spelling the id twice — a ui → controller import, which is safe only because
 * this module is constants plus a factory with no import-time side effects.
 */
const AREA_ID_PREFIX = 'dw-area-';

/**
 * DOM id of the BoardFocus button for a territory.
 *
 * @param {number} areaId
 * @returns {string}
 */
export function areaElementId(areaId) {
  return `${AREA_ID_PREFIX}${areaId}`;
}

/**
 * The territory id behind an element, or null when it is not one of the board's
 * buttons — which is how "is focus on the board?" is answered now that the board
 * has real elements. Strict about the suffix (a positive integer, no leading
 * zeros) so an unrelated id that merely starts with the prefix cannot be read as
 * territory NaN.
 *
 * @param {EventTarget|Element|null} el
 * @returns {number|null}
 */
function areaIdOf(el) {
  const id = el?.id;
  if (typeof id !== 'string' || !id.startsWith(AREA_ID_PREFIX)) return null;
  const rest = id.slice(AREA_ID_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(rest)) return null;
  return Number(rest);
}

/**
 * Focus is nowhere in particular: the state a fresh playing screen starts in,
 * and the state a `blur()` or a removed element leaves behind. The arrows enter
 * the board from here.
 *
 * @param {Element|null} el - Typically document.activeElement
 * @returns {boolean}
 */
function isUnfocused(el) {
  return !el || el === document.body || el === document.documentElement;
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
 * @returns {{ focusFromPointer: (areaId: number) => boolean, destroy: () => void }}
 */
export function createKeyboardController(store, controller, renderer) {
  let warnedNoCellPos = false;
  let warnedNoButton = false;

  /**
   * One-shot: the board's DOM focus targets are missing, and missing for good.
   *
   * A lookup that fails while the store says playing + human turn is never
   * transient — GameStore notifies synchronously and Preact flushes on a
   * microtask, well before the next input event — so it means BoardFocus is not
   * mounted, an ErrorBoundary is showing its fallback in its place, the id
   * contract between the two files broke, or the two files disagree on which
   * areas are live. Warn once rather than on every arrow.
   */
  function warnNoBoardButton(areaId) {
    if (warnedNoButton) return;
    warnedNoButton = true;
    console.warn(
      `[KeyboardController] no board button for territory ${areaId} — is BoardFocus mounted?`
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

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight': {
        const fromId = areaIdOf(document.activeElement);
        // On a real control the arrows are the browser's — see the header.
        if (fromId == null && !isUnfocused(document.activeElement)) return;
        e.preventDefault();
        moveFocus(e.key, gameState, fromId, humanIdx);
        break;
      }
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
    }
  }

  /**
   * A territory button took focus, or something else did — mirror it into the
   * store and the renderer's ring.
   *
   * Every focus move ends here, whatever caused it: the browser's own Tab walk,
   * a click, `focusArea` below, or a dialog restoring focus on close. That is
   * why the arrow handler writes no state of its own.
   */
  function handleFocusIn(e) {
    if (store.getState().screen !== 'playing') return;
    const id = areaIdOf(e.target);
    if (id != null) {
      setFocus(id);
      return;
    }
    // Focus moved to a real control: the ring would otherwise stay painted on a
    // territory the keys no longer reach.
    if (store.getState().focusedAreaId != null) clearBoardFocus();
  }

  /**
   * Focus left a territory button for something that is not a focusable element
   * at all — a click on the canvas, a `blur()`, the window losing focus. There
   * is no matching `focusin` in any of those cases, so this is what takes the
   * ring down; when the window comes back, `focusin` puts it up again.
   *
   * Button → button is left alone: the incoming `focusin` repaints the ring on
   * the new territory, and clearing it in between is a visible flicker.
   *
   * Deliberately not guarded on `screen === 'playing'` the way handleFocusIn
   * is: Chromium fires a focusout (with a null `relatedTarget`) for an element
   * removed while it holds focus, and that event arrives after the screen has
   * already changed — game over unmounts the buttons — where it still has to
   * take the ring down. Firefox and jsdom fire nothing at all, which is why
   * GameController nulls `focusedAreaId` at that same seam.
   */
  function handleFocusOut(e) {
    if (areaIdOf(e.target) == null) return;
    if (areaIdOf(e.relatedTarget) != null) return;
    if (store.getState().focusedAreaId == null) return;
    clearBoardFocus();
  }

  /**
   * Move DOM focus to the neighbor closest to the given direction, or onto the
   * first own territory when focus is not on the board yet.
   *
   * @param {string} key - The arrow key
   * @param {Object} gameState
   * @param {number|null} fromId - Territory that has DOM focus, or null
   * @param {number} humanIdx
   */
  function moveFocus(key, gameState, fromId, humanIdx) {
    if (fromId == null) {
      const firstOwn = findFirstOwnTerritory(gameState, humanIdx);
      if (firstOwn) focusArea(firstOwn);
      return;
    }

    const area = gameState.areas[fromId];
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

    if (bestNeighbor !== null) focusArea(bestNeighbor);
  }

  /**
   * Put DOM focus on a territory's button. Deliberately writes nothing: the
   * `focusin` it raises is what updates the store and the ring, so this path is
   * identical to a Tab or a dialog's focus restore.
   *
   * `preventScroll` because the buttons are clipped to a pixel in a corner —
   * scrolling them into view would jump the page away from the board.
   */
  function focusArea(areaId) {
    const el = document.getElementById(areaElementId(areaId));
    if (!el) {
      warnNoBoardButton(areaId);
      return;
    }
    el.focus({ preventScroll: true });
    // A present element that refuses focus (disabled, detached) leaves the ring
    // and DOM focus where they were, which is the honest outcome — but it is
    // still a wiring bug worth one line in the console.
    if (document.activeElement !== el) warnNoBoardButton(areaId);
  }

  /**
   * A pointer went down on a territory: keep the keyboard's position on it,
   * rather than letting the click blur the board to `<body>`.
   *
   * Only when the board already holds DOM focus. A mouse-only player has no
   * territory focused and never gets a ring out of this — clicking is not asking
   * for a keyboard cursor — and focus that belongs to a real control is left
   * where it is. Moving focus goes through `focusArea`, so the `focusin` mirror
   * does the store and ring bookkeeping down the one path everything else uses.
   *
   * @param {number} areaId - The territory under the pointer
   * @returns {boolean} True when DOM focus is now on that territory's button —
   *   which is main.jsx's cue to preventDefault() the pointerdown and with it
   *   the browser's focus fixup. False means nothing moved and the default is
   *   the browser's to keep.
   */
  function focusFromPointer(areaId) {
    if (areaIdOf(document.activeElement) == null) return false;
    focusArea(areaId);
    const el = document.getElementById(areaElementId(areaId));
    return el != null && document.activeElement === el;
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
    /*
     * The selection and the keyboard's focus are different things, and only the
     * selection was cancelled — so this is clearSelectionHighlights(), which
     * leaves the focus ring where DOM focus still is (#211 item 3). It used to
     * be clearHighlights() plus a repaint of the ring; now the ring never comes
     * down.
     */
    if (renderer) renderer.hexGrid.clearSelectionHighlights();
    /*
     * clearSelectionHighlights() takes the board hints down with the selection,
     * and this is a return to selectFrom — so hand back to the controller, which
     * owns that mapping, to repaint the attack candidates.
     */
    controller.refreshCandidateHighlights();
    return true;
  }

  function setFocus(areaId) {
    store.setState({ focusedAreaId: areaId });
    if (renderer) renderer.hexGrid.setFocusHighlight(areaId);
  }

  /** Take the ring down — the board no longer holds DOM focus. */
  function clearBoardFocus() {
    store.setState({ focusedAreaId: null });
    if (renderer) renderer.hexGrid.clearFocusHighlight();
  }

  /**
   * Where the arrows enter the board. "Live" has to mean here exactly what it
   * means in BoardFocus — an area that is missing or has `size === 0` gets no
   * button — or this hands back an id nothing on the page can focus. The engine
   * happens never to give a size-0 sentinel an owner, but that is the engine's
   * invariant to keep, not this file's.
   */
  function findFirstOwnTerritory(gameState, humanIdx) {
    const areas = gameState.areas;
    for (let a = 1; a < (areas.length || Object.keys(areas).length + 1); a++) {
      const area = areas[a];
      if (!area || area.size === 0) continue;
      if (area.owner === humanIdx) return a;
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
  document.addEventListener('focusout', handleFocusOut);

  return {
    focusFromPointer,
    destroy() {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    },
  };
}
