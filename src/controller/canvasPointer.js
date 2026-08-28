/**
 * Canvas Pointer Handler
 *
 * The `pointerdown` listener main.jsx hangs on the PixiJS canvas. One press on
 * the board is hit-tested to a territory id and becomes at most two things: the
 * keyboard cursor following the pointer, and the move itself. It lives here
 * rather than inline in main.jsx because main.jsx is the one module the test
 * suite cannot instantiate — it is the app's boot sequence — and the decisions
 * below (which buttons act, what a click on water does) are worth pinning
 * (#211 follow-up 22).
 *
 * What this module cannot pin is the ORDER it runs in relative to the other
 * `pointerdown` listener in the app: SettingsPanel's click-outside sits on
 * `document` and therefore runs after this element-level one on the same press,
 * so an open dropdown closes and the board still gets the click. That is the
 * DOM's bubble order, not this factory's, and no unit test of this function
 * observes it — confirmed by hand in Chromium instead (a water click with the
 * dropdown open both closes it and cancels the selection), so #211 follow-up 34
 * stays open for the automated pin.
 *
 * @module controller/canvasPointer
 */

/**
 * Build the canvas `pointerdown` listener.
 *
 * @param {Object} deps
 * @param {Object|null} deps.renderer - GameRenderer, or null when there is none (see below)
 * @param {Object} deps.keyboard - KeyboardController (for `focusFromPointer`)
 * @param {Object} deps.controller - GameController (for `handleTerritoryClick`)
 * @returns {(e: PointerEvent) => void} The listener
 */
export function createCanvasPointerDown({ renderer, keyboard, controller }) {
  return function handleCanvasPointerDown(e) {
    /*
     * No renderer means no board to hit-test against. main.jsx wires this
     * listener whenever the canvas element exists, so `renderer` is null exactly
     * when constructing the GameRenderer threw; a renderer whose `init()` threw
     * is still an object and reaches the hit test, which answers 0 for an
     * uninitialized renderer (GameRenderer.hitTest) — water, and harmless.
     */
    if (!renderer) return;

    /*
     * The primary button only (`button === 0`, which is also what touch and pen
     * report on first contact). The board is a thing you point at, and a right-
     * or middle-click is not pointing: it used to select a source or land an
     * attack, so the context menu opened over a half-made attack (#211 follow-up
     * 15). Nothing here cancels `contextmenu` — that is a different event and
     * the menu is the player's to have — a secondary press simply does nothing
     * to the board.
     */
    if (e.button !== 0) return;

    const areaId = renderer.hitTest(e.clientX, e.clientY);

    /*
     * Carry the keyboard's position to the clicked territory (#211). Taken only
     * when the board already held DOM focus — `focusFromPointer` says so by
     * returning true — so a mouse-only player never acquires a focus ring by
     * clicking. preventDefault() on the pointerdown suppresses the compatibility
     * mousedown, and with it the browser's focus fixup, which would otherwise
     * have blurred the button we just focused to `<body>`; the `click` still
     * fires and nothing on the canvas listens for it.
     *
     * A click on WATER (`areaId === 0`) is deliberately not offered to
     * `focusFromPointer` at all, so the default stands even with a territory
     * focused: focus drops to `<body>`, KeyboardController's `focusout` takes the
     * ring down, and a click on nothing is as good a way as any to say "done with
     * the keyboard position".
     */
    if (areaId > 0 && keyboard.focusFromPointer(areaId)) e.preventDefault();

    /*
     * Water reaches the controller too, and must: `handleTerritoryClick(0)` is
     * how a half-made attack gets cancelled by clicking off the board (#211
     * follow-up 16). Everything else about which clicks count — the screen, the
     * animation, whose turn it is — is the controller's to judge, not ours.
     */
    controller.handleTerritoryClick(areaId);
  };
}
