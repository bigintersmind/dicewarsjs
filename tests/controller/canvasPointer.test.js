// @vitest-environment jsdom
/**
 * Canvas pointer handler tests
 *
 * The listener main.jsx puts on the PixiJS canvas. Three decisions live in it
 * and none of them had coverage before (#211 follow-up 22): only the primary
 * button acts on the board (follow-up 15), the keyboard cursor follows the
 * pointer only when `focusFromPointer` says it moved, and a click on water
 * still reaches the controller so a half-made attack can be cancelled.
 */

import { createCanvasPointerDown } from '../../src/controller/canvasPointer.js';

/**
 * jsdom 24 does not implement `PointerEvent`, so the events are `MouseEvent`s
 * of type `pointerdown` — carrying everything the handler actually reads
 * (`button`, `clientX/Y`, `preventDefault`), and `defaultPrevented` reflects the
 * handler's own call on an undispatched event just as it would on a live one.
 *
 * The handler is called directly rather than dispatched at a real canvas
 * because jsdom swallows anything a listener throws: dispatching would let a
 * handler that lost its `renderer` guard blow up on `null.hitTest` and still
 * satisfy every "nothing was called" assertion below.
 */
function press(handler, { button = 0, clientX = 10, clientY = 20 } = {}) {
  const event = new MouseEvent('pointerdown', { button, clientX, clientY, cancelable: true });
  handler(event);
  return event;
}

function makeDeps({ areaId = 5, focusMoved = false } = {}) {
  return {
    renderer: { hitTest: vi.fn(() => areaId) },
    keyboard: { focusFromPointer: vi.fn(() => focusMoved) },
    controller: { handleTerritoryClick: vi.fn() },
  };
}

describe('createCanvasPointerDown', () => {
  it('asks the focus layer to follow the pointer and suppresses the default when it did', () => {
    const deps = makeDeps({ areaId: 5, focusMoved: true });

    const event = press(createCanvasPointerDown(deps), { clientX: 42, clientY: 99 });

    expect(deps.renderer.hitTest).toHaveBeenCalledWith(42, 99);
    expect(deps.keyboard.focusFromPointer).toHaveBeenCalledWith(5);
    // The preventDefault is what stops the compatibility mousedown's focus
    // fixup from blurring the button focusFromPointer just focused.
    expect(event.defaultPrevented).toBe(true);
    expect(deps.controller.handleTerritoryClick).toHaveBeenCalledWith(5);
  });

  it('leaves the default alone when the cursor did not move, and still plays the click', () => {
    const deps = makeDeps({ areaId: 5, focusMoved: false });

    const event = press(createCanvasPointerDown(deps));

    expect(deps.keyboard.focusFromPointer).toHaveBeenCalledWith(5);
    // A mouse-only player has no ring to keep: nothing was focused, so there is
    // no browser default worth suppressing.
    expect(event.defaultPrevented).toBe(false);
    expect(deps.controller.handleTerritoryClick).toHaveBeenCalledWith(5);
  });

  it.each([
    ['secondary', 2],
    ['middle', 1],
  ])('ignores a %s-button press on a territory entirely', (_label, button) => {
    const deps = makeDeps({ areaId: 5, focusMoved: true });

    const event = press(createCanvasPointerDown(deps), { button });

    // Not even hit-tested: a right-click is not the player pointing at the
    // board, so it plays no move and moves no cursor — and because nothing here
    // touches the event, the context menu it is really asking for still opens.
    expect(deps.renderer.hitTest).not.toHaveBeenCalled();
    expect(deps.keyboard.focusFromPointer).not.toHaveBeenCalled();
    expect(deps.controller.handleTerritoryClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('forwards a click on water without offering it to the focus layer', () => {
    const deps = makeDeps({ areaId: 0, focusMoved: true });

    const event = press(createCanvasPointerDown(deps));

    // The ring is meant to drop on a water click, so the default stands and the
    // focus layer is never consulted...
    expect(deps.keyboard.focusFromPointer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    // ...while the controller still hears about it, which is how a half-made
    // attack gets cancelled by clicking off the board.
    expect(deps.controller.handleTerritoryClick).toHaveBeenCalledWith(0);
  });

  it('does nothing at all without a renderer', () => {
    const deps = makeDeps();
    const handler = createCanvasPointerDown({ ...deps, renderer: null });

    const event = press(handler);

    expect(deps.keyboard.focusFromPointer).not.toHaveBeenCalled();
    expect(deps.controller.handleTerritoryClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
