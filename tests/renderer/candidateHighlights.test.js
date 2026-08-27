// @vitest-environment jsdom
/**
 * HexGridRenderer — the overlay layers
 *
 * Mostly the board-hint layer this file was written for, plus the guards the
 * single-territory overlays share with it: the missing-border report (#211
 * item 4) and the keyboard focus ring's survival of a territory repaint (#211
 * item 3). They live here because they need the same PixiJS mock and the same
 * real-board `makeRenderer`, and because half the invariants below are already
 * about how the hint layer and the focus ring stay out of each other's way.
 *
 * A fourth overlay that outlines every territory the human can act on right
 * now. It has to paint a *set* into one Graphics (the selection overlays only
 * ever hold one territory), stay beneath the from/to selection and the keyboard
 * focus ring so those keep the eye, and go down with the selection at every
 * mid-game clear — `clearSelectionHighlights()`, which leaves the focus ring
 * alone (#211 item 3) — as well as with the full `clearHighlights()`.
 *
 * Only the GPU-touching PixiJS surface (Container, Graphics) is stubbed; the
 * board is a real engine map, so the borders traced here are real geometry.
 */

import { createGame } from '../../src/engine/index.js';
import { THEMES } from '../../src/renderer/themes.js';

vi.mock('pixi.js', () => {
  class MockContainer {
    constructor() {
      this.children = [];
      this.x = 0;
      this.y = 0;
      this.scale = { set: () => {} };
    }

    addChild(child) {
      this.children.push(child);
      return child;
    }

    addChildAt(child, index) {
      this.children.splice(index, 0, child);
      return child;
    }

    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    }

    setChildIndex(child, index) {
      this.removeChild(child);
      this.children.splice(index, 0, child);
    }
  }

  class MockGraphics {
    constructor() {
      this.visible = true;
      this.alpha = 1;
      /** Every shape appended since the last clear(): { fill, stroke } */
      this.shapes = [];
      this.clears = 0;
      this._pending = null;
    }

    clear() {
      this.clears++;
      this.shapes = [];
      this._pending = null;
      return this;
    }

    poly() {
      this._pending = {};
      this.shapes.push(this._pending);
      return this;
    }

    fill(style) {
      if (this._pending) this._pending.fill = style;
      return this;
    }

    stroke(style) {
      if (this._pending) this._pending.stroke = style;
      return this;
    }

    destroy() {}
  }

  return { Container: MockContainer, Graphics: MockGraphics };
});

const { HexGridRenderer } = await import('../../src/renderer/HexGridRenderer.js');

/** A real (small, deterministic) board, so border tracing is exercised for real. */
function makeBoard() {
  return createGame({ playerCount: 2, mapWidth: 20, mapHeight: 24, maxAreas: 20 });
}

function makeRenderer() {
  const parent = { addChild: c => c };
  const renderer = new HexGridRenderer(parent);
  const state = makeBoard();
  renderer.drawMap(state);
  // Territories that actually exist on this board (drawMap traced a border).
  const drawn = [];
  for (let a = 1; a < state.areas.length && drawn.length < 3; a++) {
    if (renderer._borders[a]) drawn.push(a);
  }
  return { renderer, state, drawn };
}

describe('setCandidateHighlights', () => {
  it('paints every requested territory into the single candidate layer', () => {
    const { renderer, drawn } = makeRenderer();
    const layer = renderer._highlightCandidates;

    renderer.setCandidateHighlights(drawn, 'attacker');

    expect(layer.visible).toBe(true);
    // Two passes per territory: the dark rim, then the bright core on top.
    expect(layer.shapes).toHaveLength(drawn.length * 2);
  });

  it('rims every ring in the dark halo so it reads on the bright player palette', () => {
    const { renderer, drawn } = makeRenderer();
    const layer = renderer._highlightCandidates;

    renderer.setCandidateHighlights([drawn[0]], 'target');
    const [rim, core] = layer.shapes;

    expect(rim.stroke.color).toBe(THEMES.dark.candidateHalo);
    expect(rim.stroke.width).toBeGreaterThan(core.stroke.width);
    expect(rim.fill.alpha).toBe(0); // the rim contributes an outline only
    expect(core.stroke.color).toBe(THEMES.dark.candidateTarget);
  });

  it('gives targets a different treatment from attack candidates', () => {
    const { renderer, drawn } = makeRenderer();
    const layer = renderer._highlightCandidates;

    renderer.setCandidateHighlights([drawn[0]], 'attacker');
    const attacker = layer.shapes[1]; // [rim, core]

    renderer.setCandidateHighlights([drawn[0]], 'target');
    const target = layer.shapes[1];

    // Hue, stroke weight and fill density all differ, so the two never rely on
    // color alone to be told apart. (Layer alpha differs too, but that's a
    // tuning constant, not part of the contract.)
    expect(attacker.stroke.color).not.toBe(target.stroke.color);
    expect(target.stroke.width).toBeGreaterThan(attacker.stroke.width);
    expect(target.fill.alpha).toBeGreaterThan(attacker.fill.alpha);
  });

  it('defaults to the attacker treatment', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights([drawn[0]]);
    expect(renderer._highlightCandidates.shapes[1].stroke.color).toBe(
      THEMES.dark.candidateAttacker
    );
  });

  it('replaces the previous set rather than accumulating', () => {
    const { renderer, drawn } = makeRenderer();
    const layer = renderer._highlightCandidates;

    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.setCandidateHighlights([drawn[0]], 'attacker');
    expect(layer.shapes).toHaveLength(2);
  });

  it('hides the layer for an empty set, and warns about unknown territories', () => {
    const { renderer } = makeRenderer();
    const layer = renderer._highlightCandidates;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderer.setCandidateHighlights([]);
    expect(layer.visible).toBe(false);
    expect(warn).not.toHaveBeenCalled(); // an empty set is a normal state, not a fault

    /*
     * An id with no traced border means the caller is hinting against a board
     * this renderer isn't showing — a real wiring bug, and one that used to
     * vanish into a `continue`. It still must not throw (this runs inside
     * startTurn), but it says so exactly once, with the ids it dropped.
     */
    renderer.setCandidateHighlights([9998, 9999]);
    expect(layer.visible).toBe(false);
    expect(layer.shapes).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContainEqual([9998, 9999]);

    warn.mockRestore();
  });

  it('rejects arguments that could only be a wiring bug', () => {
    const { renderer, drawn } = makeRenderer();

    // Not an array: silently coercing to [] painted an empty board.
    expect(() => renderer.setCandidateHighlights(null)).toThrow(TypeError);
    expect(() => renderer.setCandidateHighlights(drawn[0])).toThrow(/must be an array/);

    // Not one of the two treatments: silently coercing to 'attacker' painted
    // the wrong hint with no way to notice.
    expect(() => renderer.setCandidateHighlights(drawn, 'targets')).toThrow(TypeError);
    expect(() => renderer.setCandidateHighlights(drawn, undefined)).not.toThrow(); // the default
    expect(() => renderer.setCandidateHighlights(drawn, null)).toThrow(
      /must be 'attacker' or 'target'/
    );
  });

  it('repaints in the new palette when the theme changes', () => {
    const { renderer, drawn } = makeRenderer();
    const layer = renderer._highlightCandidates;

    renderer.setCandidateHighlights([drawn[0]], 'target');
    expect(layer.shapes[1].stroke.color).toBe(THEMES.dark.candidateTarget);

    renderer.setTheme(THEMES.light);
    expect(layer.shapes[1].stroke.color).toBe(THEMES.light.candidateTarget);
    expect(layer.visible).toBe(true);
  });
});

describe('clearing the candidate layer', () => {
  it('clearCandidateHighlights takes it down', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.clearCandidateHighlights();
    expect(renderer._highlightCandidates.visible).toBe(false);
    expect(renderer._highlightCandidates.shapes).toHaveLength(0);
  });

  it('clearHighlights takes it down along with the selection and focus rings', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.setHighlight('from', drawn[0]);
    renderer.setFocusHighlight(drawn[1]);

    renderer.clearHighlights();

    expect(renderer._highlightCandidates.visible).toBe(false);
    expect(renderer._highlightFrom.visible).toBe(false);
    expect(renderer._highlightTo.visible).toBe(false);
    expect(renderer._highlightFocus.visible).toBe(false);
  });

  /*
   * The mid-game clear. Every seam that ends an attack or re-picks a source runs
   * this one, and the keyboard's focus ring must survive all of them: it is a
   * cursor, not a selection, and it is where the next arrow steps from (#211
   * item 3). Before the split these seams called clearHighlights() and a
   * keyboard player finished every attack with DOM focus on the target and no
   * ring on screen.
   */
  it('clearSelectionHighlights takes the selection and hints down, leaving the focus ring up', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.setHighlight('from', drawn[0]);
    renderer.setHighlight('to', drawn[1]);
    renderer.setFocusHighlight(drawn[2]);

    renderer.clearSelectionHighlights();

    expect(renderer._highlightCandidates.visible).toBe(false);
    expect(renderer._highlightCandidates.shapes).toHaveLength(0);
    expect(renderer._highlightFrom.visible).toBe(false);
    expect(renderer._highlightFrom.shapes).toHaveLength(0);
    expect(renderer._highlightTo.visible).toBe(false);
    expect(renderer._highlightTo.shapes).toHaveLength(0);
    // Untouched: still visible AND still holding its drawn outline, so a hidden
    // -but-cleared layer can't pass for a surviving ring.
    expect(renderer._highlightFocus.visible).toBe(true);
    expect(renderer._highlightFocus.shapes).toHaveLength(1);
  });

  it('drops candidates when the map is redrawn (their geometry is stale)', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.drawMap(makeBoard());
    expect(renderer._highlightCandidates.visible).toBe(false);

    /*
     * And they must stay dropped. setTheme repaints from _candidateIds, so if
     * drawMap only hid the layer instead of forgetting the ids, the next theme
     * change would resurrect the previous board's outlines over the new one.
     */
    renderer.setTheme(THEMES.light);
    expect(renderer._highlightCandidates.visible).toBe(false);
    expect(renderer._highlightCandidates.shapes).toHaveLength(0);
  });
});

/*
 * The invariant is about the HINT layer, not about which overlay is topmost.
 * drawMap re-pins `from` and `to` above everything added since (the focus ring
 * included), and GameRenderer parents the dice into this same container — so
 * the real bottom-to-top order after drawMap is
 *   territories → board hints → keyboard focus → dice → to → from
 * and the only thing the hint layer promises is to be at the bottom of it.
 */
describe('stacking order', () => {
  it('keeps the hint layer beneath every other overlay so the choice stays dominant', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');

    const { children } = renderer.container;
    const candidateIndex = children.indexOf(renderer._highlightCandidates);
    expect(candidateIndex).toBeGreaterThanOrEqual(0);
    expect(candidateIndex).toBeLessThan(children.indexOf(renderer._highlightFrom));
    expect(candidateIndex).toBeLessThan(children.indexOf(renderer._highlightTo));
    expect(candidateIndex).toBeLessThan(children.indexOf(renderer._highlightFocus));
    // ...and above the territories themselves.
    expect(candidateIndex).toBeGreaterThan(children.indexOf(renderer._territoryGfx[drawn[0]]));
  });

  it('draws the keyboard focus ring over the hints, so the focused territory still stands out', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.setFocusHighlight(drawn[0]);

    const { children } = renderer.container;
    /*
     * The attacker hint is a 2px white rim; focus is a 3px white stroke over a
     * darkened fill. Focus reads as "you are here" because it paints above the
     * hint layer — not because it is topmost overall (from/to are).
     */
    expect(children.indexOf(renderer._highlightFocus)).toBeGreaterThan(
      children.indexOf(renderer._highlightCandidates)
    );

    const focusShape = renderer._highlightFocus.shapes[0];
    const hintCore = renderer._highlightCandidates.shapes[1];
    // Heavier stroke and an opaque-ish fill are what separate it from a hint rim.
    expect(focusShape.stroke.width).toBeGreaterThan(hintCore.stroke.width);
    expect(renderer._highlightFocus.alpha).toBeGreaterThan(0.5);
  });
});

/*
 * Board hints and keyboard focus are separate Graphics on purpose: arrowing
 * around the board repaints focus many times a turn, and it must never cost the
 * player the hint set that told them where they could go.
 */
describe('keyboard focus independence', () => {
  it('survives arrowing around the board', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    const before = renderer._highlightCandidates.shapes.length;

    for (const id of [...drawn, ...drawn, ...drawn]) renderer.setFocusHighlight(id);

    expect(renderer._highlightCandidates.visible).toBe(true);
    expect(renderer._highlightCandidates.shapes).toHaveLength(before);
  });

  it('clearFocusHighlight leaves the hints up', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.setFocusHighlight(drawn[0]);

    renderer.clearFocusHighlight();

    expect(renderer._highlightFocus.visible).toBe(false);
    expect(renderer._highlightCandidates.visible).toBe(true);
    expect(renderer._highlightCandidates.shapes).toHaveLength(drawn.length * 2);
  });

  it('clearCandidateHighlights leaves the focus ring up', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.setFocusHighlight(drawn[0]);

    renderer.clearCandidateHighlights();

    expect(renderer._highlightCandidates.visible).toBe(false);
    expect(renderer._highlightFocus.visible).toBe(true);
    expect(renderer._highlightFocus.shapes).toHaveLength(1);
  });
});

/*
 * Color-blind mode swaps the PLAYER palette only. The hint colors come from the
 * theme, so they stay put — which is the point: the ring keeps the same meaning
 * in both modes, and its dark halo keeps it a ring rather than a hue.
 */
describe('color-blind mode', () => {
  it('leaves the hint colors alone when the player palette is swapped', () => {
    const { renderer, state, drawn } = makeRenderer();
    renderer.setCandidateHighlights([drawn[0]], 'target');
    const before = renderer._highlightCandidates.shapes[1].stroke.color;

    renderer.setColorBlindMode(true);
    renderer.redrawAll(state);

    expect(renderer._highlightCandidates.visible).toBe(true);
    expect(renderer._highlightCandidates.shapes[1].stroke.color).toBe(before);
    expect(before).toBe(THEMES.dark.candidateTarget);
  });

  it('keeps the halo under the white attacker rim, which is what carries it over a black seat', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setColorBlindMode(true);
    renderer.setCandidateHighlights([drawn[0]], 'attacker');
    const [halo, core] = renderer._highlightCandidates.shapes;

    // On COLORBLIND_PLAYER_COLORS[7] (black) the halo is invisible, so the
    // bright core has to be the mark — it is drawn second, over the halo.
    expect(core.stroke.color).toBe(THEMES.dark.candidateAttacker);
    expect(core.stroke.width).toBeGreaterThan(0);
    expect(halo.stroke.width).toBeGreaterThan(core.stroke.width);
  });
});

/**
 * Return a copy of `state` with one territory handed to a different owner.
 * Cheap enough to keep the engine out of it: the renderer only reads
 * `areas[id].owner`, and nothing here depends on the move that would have
 * caused the flip being legal.
 */
function withOwner(state, areaId, owner) {
  return { ...state, areas: state.areas.map((a, i) => (i === areaId && a ? { ...a, owner } : a)) };
}

/*
 * #211 item 4. `setFocusHighlight` and `setHighlight` both used to return
 * silently when the id had no traced border — the same store/renderer map
 * mismatch `setCandidateHighlights` has warned about all along. Silence there is
 * worse than on the hint layer: since #213 the focus ring is painted from the
 * focusin mirror, so a swallowed miss leaves the store saying "focused" with
 * nothing on screen — exactly the desync #211 item 3 closed everywhere else.
 */
describe('missing borders on the single-territory overlays', () => {
  it('setFocusHighlight warns, and still leaves the layer down', () => {
    const { renderer } = makeRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderer.setFocusHighlight(9999);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('setFocusHighlight');
    expect(warn.mock.calls[0]).toContain(9999);
    // Warning is all it does: no ring, and above all no throw — this runs from
    // a focus listener, where an exception would take the keyboard down.
    expect(renderer._highlightFocus.visible).toBe(false);
    expect(renderer._highlightFocus.shapes).toHaveLength(0);

    warn.mockRestore();
  });

  it('says it once per renderer, not once per keypress', () => {
    const { renderer } = makeRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // An arrow burst across a mismatched map is one fault, not twelve. The
    // sibling can afford a line per call because each of its calls is a whole
    // set; this one is called once per hop.
    renderer.setFocusHighlight(9999);
    renderer.setFocusHighlight(9998);
    renderer.setFocusHighlight(9999);

    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it('keeps painting real territories after a warned miss', () => {
    const { renderer, drawn } = makeRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderer.setFocusHighlight(9999);
    renderer.setFocusHighlight(drawn[0]);

    expect(renderer._highlightFocus.visible).toBe(true);
    expect(renderer._highlightFocus.shapes).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it('setHighlight warns on its own budget, independently of the focus ring', () => {
    const { renderer } = makeRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderer.setFocusHighlight(9999);
    renderer.setHighlight('from', 9999);
    // The record is per METHOD, so the second selection ring is covered by the
    // first: one mismatched map is one report per entry point, and 'from' and
    // 'to' are the same entry point.
    renderer.setHighlight('to', 9998);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('setFocusHighlight');
    expect(warn.mock.calls[1][0]).toContain('setHighlight');
    expect(renderer._highlightFrom.visible).toBe(false);
    expect(renderer._highlightTo.visible).toBe(false);

    warn.mockRestore();
  });

  it('gets a fresh budget when drawMap retraces the borders', () => {
    const { renderer } = makeRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderer.setFocusHighlight(9999);
    renderer.drawMap(makeBoard());
    renderer.setFocusHighlight(9999);

    // A new board is a new chance to be wired against the wrong game, and the
    // flags are reset where `_borders` is rebuilt so the report isn't spent on
    // the previous map.
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });
});

/*
 * The ring is a cursor: it marks where the keyboard is, so it has to outlive the
 * territory under it changing hands (#211 item 3's behaviour decision — a player
 * who presses E leaves focus parked on a territory the AI may then conquer).
 *
 * Nothing enforces this explicitly — it holds because territory repaints draw
 * into `_territoryGfx[id]` and never reach into the overlay layers — so these
 * tests were green the day they were written. They are here as a pin: they fail
 * the moment a repaint path decides to take the ring down (verified by
 * temporarily adding `clearFocusHighlight()` to `redrawTerritory`), which is
 * precisely the regression the item-3 argument was resting on inspection for.
 */
describe('the focus ring across a change of ownership', () => {
  it('survives redrawTerritory on the focused territory', () => {
    const { renderer, state, drawn } = makeRenderer();
    const focused = drawn[0];
    renderer.setFocusHighlight(focused);

    const next = withOwner(state, focused, state.areas[focused].owner === 0 ? 1 : 0);
    renderer.redrawTerritory(focused, next);

    expect(renderer._highlightFocus.visible).toBe(true);
    expect(renderer._highlightFocus.shapes).toHaveLength(1);
  });

  it('survives the updateFromState sweep that follows an AI attack', () => {
    const { renderer, state, drawn } = makeRenderer();
    const focused = drawn[0];
    renderer.setFocusHighlight(focused);

    const next = withOwner(state, focused, state.areas[focused].owner === 0 ? 1 : 0);
    renderer.updateFromState(state, next);

    expect(renderer._highlightFocus.visible).toBe(true);
    expect(renderer._highlightFocus.shapes).toHaveLength(1);
  });
});
