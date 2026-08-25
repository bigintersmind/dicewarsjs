// @vitest-environment jsdom
/**
 * HexGridRenderer — board-hint layer
 *
 * A fourth overlay that outlines every territory the human can act on right
 * now. It has to paint a *set* into one Graphics (the selection overlays only
 * ever hold one territory), stay beneath the from/to selection and the keyboard
 * focus ring so those keep the eye, and go down with `clearHighlights()` like
 * everything else.
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
    const attacker = { ...layer.shapes[1], alpha: layer.alpha }; // [rim, core]

    renderer.setCandidateHighlights([drawn[0]], 'target');
    const target = { ...layer.shapes[1], alpha: layer.alpha };

    // Hue, stroke weight and fill density all differ, so the two never rely on
    // color alone to be told apart.
    expect(attacker.stroke.color).not.toBe(target.stroke.color);
    expect(target.stroke.width).toBeGreaterThan(attacker.stroke.width);
    expect(target.fill.alpha).toBeGreaterThan(attacker.fill.alpha);
    expect(target.alpha).toBeGreaterThan(attacker.alpha);
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

  it('hides the layer for an empty set, and ignores unknown territories', () => {
    const { renderer } = makeRenderer();
    const layer = renderer._highlightCandidates;

    renderer.setCandidateHighlights([]);
    expect(layer.visible).toBe(false);

    renderer.setCandidateHighlights([9999]);
    expect(layer.visible).toBe(false);
    expect(layer.shapes).toHaveLength(0);
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

  it('falls back to the dark palette for a theme without candidate colors', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setTheme({ borderColor: 0x111111, highlightColor: 0x222222, highlightFill: 0x333333 });
    renderer.setCandidateHighlights([drawn[0]], 'attacker');
    expect(renderer._highlightCandidates.shapes[1].stroke.color).toBe(
      THEMES.dark.candidateAttacker
    );
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

  it('drops candidates when the map is redrawn (their geometry is stale)', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.drawMap(makeBoard());
    expect(renderer._highlightCandidates.visible).toBe(false);
  });
});

describe('stacking order', () => {
  it('keeps candidates beneath the from/to selection so the choice stays dominant', () => {
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

  it('draws the keyboard focus ring ON TOP of the hints, so the focused territory still stands out', () => {
    const { renderer, drawn } = makeRenderer();
    renderer.setCandidateHighlights(drawn, 'attacker');
    renderer.setFocusHighlight(drawn[0]);

    const { children } = renderer.container;
    /*
     * The attacker hint is a 2px white rim; focus is a 3px white stroke over a
     * darkened fill. Focus only reads as "you are here" if it paints last —
     * which the constructor guarantees by adding it after the hint layer.
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
