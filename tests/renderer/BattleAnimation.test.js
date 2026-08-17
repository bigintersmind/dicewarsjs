// @vitest-environment jsdom
/**
 * BattleAnimation cancel/teardown (#181).
 *
 * `cancel()` is what lets a game be abandoned mid-roll: it takes the roll off
 * the ticker, clears the dice, and — critically — resolves the promise `play()`
 * handed out. The AI loop and the human attack path are both parked on that
 * promise; if it is ever left hanging, `aiRunning` stays true and every later
 * game's AI is dead. Nothing else in the suite exercises it.
 *
 * Only the GPU-touching PixiJS surface is stubbed (the same idiom as
 * GameRendererDiceSync.test.js); the animation's own bookkeeping is real, and
 * the fake ticker exposes its callback count so "is this roll still driving the
 * canvas?" is directly observable.
 */

import { createBattleAnimation } from '../../src/renderer/BattleAnimation.js';

vi.mock('pixi.js', () => {
  class MockContainer {
    constructor() {
      this.children = [];
      this.visible = true;
      this.x = 0;
      this.y = 0;
      this.scale = { set: () => {} };
      this.destroyed = false;
    }

    addChild(child) {
      this.children.push(child);
      return child;
    }

    removeChildren() {
      const removed = this.children;
      this.children = [];
      return removed;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  class MockGraphics extends MockContainer {
    rect() {
      return this;
    }

    roundRect() {
      return this;
    }

    circle() {
      return this;
    }

    poly() {
      return this;
    }

    fill() {
      return this;
    }

    stroke() {
      return this;
    }

    clear() {
      return this;
    }
  }

  class MockText extends MockContainer {
    constructor(options) {
      super();
      this.text = options?.text ?? '';
      this.style = {};
      this.anchor = { set: () => {} };
    }
  }

  return { Container: MockContainer, Graphics: MockGraphics, Text: MockText };
});

/** Fake PixiJS app whose ticker reports how many callbacks are registered. */
function makeApp() {
  const callbacks = new Set();
  return {
    stage: { addChild: () => {} },
    ticker: {
      add: cb => callbacks.add(cb),
      remove: cb => callbacks.delete(cb),
      get size() {
        return callbacks.size;
      },
      tick: (frame = { deltaTime: 1, deltaMS: 16 }) => {
        for (const cb of [...callbacks]) cb(frame);
      },
    },
  };
}

const RESULT = {
  success: true,
  attackerRoll: { values: [6, 5], total: 11 },
  defenderRoll: { values: [1], total: 1 },
};

/** Drive the ticker until the animation finishes (bounded so a bug fails fast). */
function runToCompletion(app) {
  for (let i = 0; i < 400 && app.ticker.size > 0; i++) app.ticker.tick();
}

describe('BattleAnimation cancel/teardown', () => {
  it('cancel() resolves the promise play() handed out', async () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);
    let done = false;
    const pending = anim.play(RESULT, 0, 1).then(() => {
      done = true;
    });
    expect(app.ticker.size).toBe(1);
    expect(done).toBe(false);

    anim.cancel();
    await pending;

    // A caller left awaiting here would wedge the AI loop for the rest of the session.
    expect(done).toBe(true);
    expect(app.ticker.size).toBe(0);
    expect(anim.container.visible).toBe(false);
    expect(anim.container.children).toHaveLength(0);
  });

  it('a cancelled animation stops driving the ticker', () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);
    anim.play(RESULT, 0, 1);

    anim.cancel();

    // Left on, the callback would keep animating dice this cancel just disposed.
    expect(app.ticker.size).toBe(0);
    expect(() => app.ticker.tick()).not.toThrow();
  });

  it('play() after cancel starts a fresh animation that still finishes', async () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);
    anim.play(RESULT, 0, 1);
    anim.cancel();

    let done = false;
    const pending = anim.play(RESULT, 0, 1).then(() => {
      done = true;
    });
    expect(app.ticker.size).toBe(1);

    runToCompletion(app);
    await pending;

    expect(done).toBe(true);
    expect(app.ticker.size).toBe(0);
  });

  it('cancel() is a no-op when nothing is playing', () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);

    expect(() => anim.cancel()).not.toThrow();
    expect(app.ticker.size).toBe(0);
  });

  it('a second cancel() is inert', async () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);
    let resolutions = 0;
    const pending = anim.play(RESULT, 0, 1).then(() => {
      resolutions++;
    });

    anim.cancel();
    /*
     * The stale resolver has to be released, not just called: re-invoking a
     * settled promise's resolve is silently ignored, so a leaked one only shows
     * up later — as a *different* roll's caller being resolved early. What is
     * observable here is that the repeat cancel finds nothing to do.
     */
    expect(() => anim.cancel()).not.toThrow();
    await pending;

    expect(resolutions).toBe(1);
    expect(app.ticker.size).toBe(0);
    expect(anim.container.visible).toBe(false);
  });

  it('a superseding play() removes the previous tick', () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);
    anim.play(RESULT, 0, 1);

    anim.play(RESULT, 0, 1);

    // Two live callbacks would fight over one container of dice.
    expect(app.ticker.size).toBe(1);
  });

  it('destroy() takes the roll off the ticker and frees its awaiting caller', async () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);
    let done = false;
    const pending = anim.play(RESULT, 0, 1).then(() => {
      done = true;
    });

    anim.destroy();
    await pending;

    expect(done).toBe(true);
    // The container is gone; a surviving callback would tick against destroyed objects.
    expect(app.ticker.size).toBe(0);
    expect(() => app.ticker.tick()).not.toThrow();
  });

  it('play() with a malformed battleResult clears the roll in flight', async () => {
    const app = makeApp();
    const anim = createBattleAnimation(app);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let done = false;
    const pending = anim.play(RESULT, 0, 1).then(() => {
      done = true;
    });

    await anim.play({ success: true }, 0, 1);
    await pending;

    // The malformed call must not leave the previous roll running (or awaited) behind it.
    expect(done).toBe(true);
    expect(app.ticker.size).toBe(0);
    expect(anim.container.visible).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
