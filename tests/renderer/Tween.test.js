// @vitest-environment jsdom
import {
  linear,
  easeIn,
  easeOut,
  easeInOut,
  bounce,
  lerpColor,
  tween,
} from '../../src/renderer/Tween.js';

describe('Easing functions', () => {
  const easings = { linear, easeIn, easeOut, easeInOut, bounce };

  for (const [name, fn] of Object.entries(easings)) {
    it(`${name}: returns 0 at t=0 and 1 at t=1`, () => {
      expect(fn(0)).toBeCloseTo(0, 5);
      expect(fn(1)).toBeCloseTo(1, 5);
    });

    it(`${name}: returns values in [0, 1] for t in [0, 1]`, () => {
      for (let t = 0; t <= 1; t += 0.1) {
        const v = fn(t);
        expect(v).toBeGreaterThanOrEqual(-0.01);
        expect(v).toBeLessThanOrEqual(1.01);
      }
    });
  }

  it('easeIn starts slow', () => {
    expect(easeIn(0.25)).toBeLessThan(0.25);
  });

  it('easeOut starts fast', () => {
    expect(easeOut(0.25)).toBeGreaterThan(0.25);
  });

  it('easeInOut is symmetric around 0.5', () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5);
  });
});

describe('lerpColor', () => {
  it('returns colorA at t=0', () => {
    expect(lerpColor(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
  });

  it('returns colorB at t=1', () => {
    expect(lerpColor(0xff0000, 0x0000ff, 1)).toBe(0x0000ff);
  });

  it('interpolates each channel independently', () => {
    const mid = lerpColor(0x000000, 0xffffff, 0.5);
    const r = (mid >> 16) & 0xff;
    const g = (mid >> 8) & 0xff;
    const b = mid & 0xff;
    // Each channel should be ~128
    expect(r).toBeGreaterThanOrEqual(127);
    expect(r).toBeLessThanOrEqual(128);
    expect(g).toBeGreaterThanOrEqual(127);
    expect(g).toBeLessThanOrEqual(128);
    expect(b).toBeGreaterThanOrEqual(127);
    expect(b).toBeLessThanOrEqual(128);
  });

  it('handles same color', () => {
    expect(lerpColor(0x336699, 0x336699, 0.5)).toBe(0x336699);
  });
});

describe('tween', () => {
  /** Create a mock ticker that allows manual frame advancement. */
  function createMockTicker() {
    const callbacks = new Set();
    return {
      add(fn) {
        callbacks.add(fn);
      },
      remove(fn) {
        callbacks.delete(fn);
      },
      /** Advance by deltaMS milliseconds. */
      advance(deltaMS) {
        for (const fn of [...callbacks]) {
          fn({ deltaMS });
        }
      },
      get size() {
        return callbacks.size;
      },
    };
  }

  it('interpolates target properties over time', async () => {
    const ticker = createMockTicker();
    const target = { x: 0, y: 0 };
    const { promise } = tween(
      target,
      { x: 100, y: 200 },
      { duration: 100, easing: linear },
      ticker
    );

    ticker.advance(50); // halfway
    expect(target.x).toBeCloseTo(50, 0);
    expect(target.y).toBeCloseTo(100, 0);

    ticker.advance(50); // done
    await promise;
    expect(target.x).toBeCloseTo(100, 0);
    expect(target.y).toBeCloseTo(200, 0);
  });

  it('resolves promise when complete', async () => {
    const ticker = createMockTicker();
    const target = { alpha: 1 };
    const { promise } = tween(target, { alpha: 0 }, { duration: 50, easing: linear }, ticker);

    ticker.advance(50);
    await promise;
    expect(target.alpha).toBeCloseTo(0, 5);
  });

  it('removes ticker callback when complete', async () => {
    const ticker = createMockTicker();
    const target = { x: 0 };
    const { promise } = tween(target, { x: 10 }, { duration: 10, easing: linear }, ticker);

    expect(ticker.size).toBe(1);
    ticker.advance(10);
    await promise;
    expect(ticker.size).toBe(0);
  });

  it('calls onUpdate with raw progress', async () => {
    const ticker = createMockTicker();
    const target = { x: 0 };
    const updates = [];
    const { promise } = tween(
      target,
      { x: 10 },
      { duration: 100, easing: linear, onUpdate: t => updates.push(t) },
      ticker
    );

    ticker.advance(25);
    ticker.advance(25);
    ticker.advance(50);
    await promise;

    expect(updates).toHaveLength(3);
    expect(updates[0]).toBeCloseTo(0.25, 5);
    expect(updates[1]).toBeCloseTo(0.5, 5);
    expect(updates[2]).toBeCloseTo(1, 5);
  });

  it('cancel stops the animation', async () => {
    const ticker = createMockTicker();
    const target = { x: 0 };
    const { promise, cancel } = tween(
      target,
      { x: 100 },
      { duration: 100, easing: linear },
      ticker
    );

    ticker.advance(30);
    cancel();
    ticker.advance(10); // trigger the cancelled check
    await promise;

    // x should be ~30, not 100
    expect(target.x).toBeCloseTo(30, 0);
    expect(ticker.size).toBe(0);
  });

  it('completes instantly when duration is 0 (reduced motion)', async () => {
    const ticker = createMockTicker();
    const target = { x: 0, y: 0 };
    const onUpdate = vi.fn();
    const { promise } = tween(target, { x: 100, y: 50 }, { duration: 0, onUpdate }, ticker);

    await promise;
    expect(target.x).toBe(100);
    expect(target.y).toBe(50);
    expect(onUpdate).toHaveBeenCalledWith(1);
    expect(ticker.size).toBe(0);
  });

  it('completes instantly when duration is negative', async () => {
    const ticker = createMockTicker();
    const target = { scale: 1 };
    const { promise } = tween(target, { scale: 2 }, { duration: -100 }, ticker);

    await promise;
    expect(target.scale).toBe(2);
  });

  it('applies easing to interpolation', async () => {
    const ticker = createMockTicker();
    const target = { x: 0 };
    const { promise } = tween(target, { x: 100 }, { duration: 100, easing: easeIn }, ticker);

    ticker.advance(50); // halfway in time
    // easeIn at t=0.5 should be 0.125, so x ~12.5 (much less than 50)
    expect(target.x).toBeLessThan(25);

    ticker.advance(50);
    await promise;
    expect(target.x).toBeCloseTo(100, 0);
  });
});
