/**
 * Dice-display-mode live-apply seam tests.
 *
 * Covers the guard/delegation/repaint logic added for the "number-only dice
 * display" feature. These methods are pure control flow over instance fields,
 * so they're exercised via `prototype.<method>.call(stub, ...)` against
 * hand-built stubs — no PixiJS Application or GPU required.
 */

import { GameRenderer } from '../../src/renderer/GameRenderer.js';
import { DiceRenderer } from '../../src/renderer/DiceRenderer.js';

describe('DiceRenderer.setDiceDisplayMode', () => {
  const setMode = (stub, mode) => DiceRenderer.prototype.setDiceDisplayMode.call(stub, mode);

  it("stores 'number' verbatim", () => {
    const stub = { _displayMode: 'dice' };
    setMode(stub, 'number');
    expect(stub._displayMode).toBe('number');
  });

  it("stores 'dice' verbatim", () => {
    const stub = { _displayMode: 'number' };
    setMode(stub, 'dice');
    expect(stub._displayMode).toBe('dice');
  });

  it("normalizes any non-'number' value to 'dice'", () => {
    for (const bad of ['pips', '', undefined, null, 0, 'NUMBER']) {
      const stub = { _displayMode: 'number' };
      setMode(stub, bad);
      expect(stub._displayMode).toBe('dice');
    }
  });
});

describe('GameRenderer.setDiceDisplayMode', () => {
  const setMode = (stub, mode) => GameRenderer.prototype.setDiceDisplayMode.call(stub, mode);

  const makeStub = (overrides = {}) => ({
    _diceDisplayMode: 'dice',
    initialized: true,
    dice: { setDiceDisplayMode: vi.fn(), drawAll: vi.fn() },
    hexGrid: { _lastState: { meta: 1 } },
    ...overrides,
  });

  it('no-ops when the mode is unchanged', () => {
    const stub = makeStub({ _diceDisplayMode: 'number' });
    setMode(stub, 'number');
    expect(stub.dice.setDiceDisplayMode).not.toHaveBeenCalled();
    expect(stub.dice.drawAll).not.toHaveBeenCalled();
  });

  it('updates the field but does not touch the renderer before init', () => {
    const stub = makeStub({ initialized: false });
    setMode(stub, 'number');
    expect(stub._diceDisplayMode).toBe('number');
    expect(stub.dice.setDiceDisplayMode).not.toHaveBeenCalled();
    expect(stub.dice.drawAll).not.toHaveBeenCalled();
  });

  it('delegates to the dice renderer and repaints when initialized with state', () => {
    const stub = makeStub();
    setMode(stub, 'number');
    expect(stub._diceDisplayMode).toBe('number');
    expect(stub.dice.setDiceDisplayMode).toHaveBeenCalledWith('number');
    expect(stub.dice.drawAll).toHaveBeenCalledWith(stub.hexGrid._lastState);
  });

  it('delegates but skips repaint when there is no current state', () => {
    const stub = makeStub({ hexGrid: { _lastState: null } });
    setMode(stub, 'number');
    expect(stub.dice.setDiceDisplayMode).toHaveBeenCalledWith('number');
    expect(stub.dice.drawAll).not.toHaveBeenCalled();
  });
});
