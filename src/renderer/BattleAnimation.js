/**
 * Battle Animation
 *
 * Animated dice combat display using PixiJS. Inspired by the legacy
 * `battle_dice()` function in main.js. Vertical bounce physics (gravity,
 * bounce count) are faithfully ported; horizontal movement uses a
 * decelerating velocity model instead of the original's accelerating offsets.
 *
 * Dice fly in from opposite sides, bounce, then settle showing their
 * final values and running totals.
 *
 * @module renderer/BattleAnimation
 */

import { Container, Graphics, Text } from 'pixi.js';
import { PLAYER_COLORS, COLORBLIND_PLAYER_COLORS, BASE_WIDTH } from './constants.js';
import { getPipPositions } from './dicePips.js';

const BG_ALPHA = 0.8;
const BG_HEIGHT = 200;
const DIE_SIZE = 24;
const DIE_GAP = 30;
const GRAVITY = 3;
const BOUNCE_REDUCTION = 3;
const MAX_BOUNCES = 2;
const INITIAL_UP_MAX = 22;
const SETTLE_FRAMES = 15;

/**
 * Create a battle animation manager.
 *
 * @param {import('pixi.js').Application} app - PixiJS app (for ticker)
 * @returns {{ play: Function, cancel: Function, destroy: Function, container: Container,
 *   setColorBlindMode: Function }}
 */
export function createBattleAnimation(app) {
  const container = new Container();
  container.visible = false;
  app.stage.addChild(container);

  /** @type {(() => void) | null} Resolve function for pending animation */
  let pendingResolve = null;
  /** @type {(() => void) | null} Ticker callback driving the current roll */
  let activeTick = null;
  /** @type {boolean} Color-blind mode */
  let colorBlindMode = false;

  function getPlayerColor(index) {
    const palette = colorBlindMode ? COLORBLIND_PLAYER_COLORS : PLAYER_COLORS;
    return palette[index % palette.length];
  }

  function setColorBlindMode(enabled) {
    colorBlindMode = enabled;
  }

  /*
   * Detach and destroy the current play's display objects. removeChildren()
   * alone leaks each child's GraphicsContext (pixi v8 frees it only on an
   * explicit destroy({ context: true })), which adds up over the many battles
   * of a long game.
   */
  function disposeChildren() {
    for (const child of container.removeChildren()) {
      child.destroy({ children: true, context: true });
    }
  }

  /**
   * Play a battle animation and return a Promise that resolves when done.
   *
   * @param {Object} battleResult - From engine: { attackerRoll, defenderRoll, success }
   * @param {number} attackerPlayerIndex - Player index of attacker
   * @param {number} defenderPlayerIndex - Player index of defender
   * @param {Object} [options]
   * @param {number} [options.speed=1] - Speed multiplier
   * @returns {Promise<void>}
   */
  function play(battleResult, attackerPlayerIndex, defenderPlayerIndex, options = {}) {
    const speed = options.speed || 1;

    if (!battleResult?.attackerRoll?.values || !battleResult?.defenderRoll?.values) {
      /*
       * Nothing to roll. Go out through cancel() rather than just hiding the
       * container: a roll already in flight owns a ticker callback and an
       * unresolved promise, and returning past that bookkeeping would leave it
       * animating invisibly with its caller awaiting forever.
       */
      console.warn('[BattleAnimation] Malformed battleResult, skipping roll:', battleResult);
      cancel();
      return Promise.resolve();
    }

    // Resolve any pending animation, and take its ticker callback off the
    // ticker — left on, it would keep running against the dice this play is
    // about to dispose.
    if (activeTick) {
      app.ticker.remove(activeTick);
      activeTick = null;
    }
    if (pendingResolve) pendingResolve();

    return new Promise(resolve => {
      pendingResolve = resolve;
      // Clear previous
      disposeChildren();
      container.visible = true;

      // Position at center-bottom of game area
      container.x = BASE_WIDTH / 2;
      container.y = BASE_WIDTH * 0.7;

      // Background
      const bg = new Graphics();
      bg.rect(-BASE_WIDTH / 2, -BG_HEIGHT / 2, BASE_WIDTH, BG_HEIGHT);
      bg.fill({ color: 0xffffff, alpha: BG_ALPHA });
      container.addChild(bg);

      const atkRoll = battleResult.attackerRoll;
      const defRoll = battleResult.defenderRoll;
      const atkValues = atkRoll.values;
      const defValues = defRoll.values;

      // Create dice objects for both sides
      const atkDice = createDiceSet(atkValues, getPlayerColor(attackerPlayerIndex), -1);
      const defDice = createDiceSet(defValues, getPlayerColor(defenderPlayerIndex), 1);

      for (const d of atkDice) container.addChild(d.gfx);
      for (const d of defDice) container.addChild(d.gfx);

      // Totals text (hidden initially)
      const atkTotalText = createTotalText(atkRoll.total, -120);
      const defTotalText = createTotalText(defRoll.total, 120);
      container.addChild(atkTotalText);
      container.addChild(defTotalText);
      atkTotalText.visible = false;
      defTotalText.visible = false;

      // Animation state
      let phase = 0; // 0 = attacker rolling, 1 = defender rolling, 2 = show result, 3 = done
      let settleWait = 0;

      function tick() {
        try {
          if (phase === 0) {
            // Animate attacker dice
            const allSettled = updateDice(atkDice, speed);
            if (allSettled) {
              atkTotalText.visible = true;
              phase = 1;
            }
          } else if (phase === 1) {
            // Animate defender dice
            const allSettled = updateDice(defDice, speed);
            if (allSettled) {
              defTotalText.visible = true;
              phase = 2;
            }
          } else if (phase === 2) {
            // Show result briefly
            settleWait++;
            if (settleWait >= SETTLE_FRAMES / speed) {
              phase = 3;
            }
          }

          if (phase === 3) {
            app.ticker.remove(tick);
            activeTick = null;
            container.visible = false;
            disposeChildren();
            pendingResolve = null;
            resolve();
          }
        } catch (err) {
          console.error('[BattleAnimation] tick error, aborting:', err);
          app.ticker.remove(tick);
          activeTick = null;
          container.visible = false;
          disposeChildren();
          pendingResolve = null;
          resolve();
        }
      }

      activeTick = tick;
      app.ticker.add(tick);
    });
  }

  /**
   * Stop the roll in flight and clear the dice off the canvas, resolving the
   * promise `play()` handed out so its awaiting caller isn't left hanging.
   * Used when a game is abandoned mid-battle (#181) — without it the dice keep
   * tumbling over whatever the canvas shows next.
   */
  function cancel() {
    if (activeTick) {
      app.ticker.remove(activeTick);
      activeTick = null;
    }
    /*
     * Take the resolver first and release it in a `finally`, so a throw while
     * tearing down the display objects still frees the awaiting caller — the AI
     * loop is parked on this promise, and leaking it wedges every later turn.
     */
    const resolveFn = pendingResolve;
    pendingResolve = null;
    try {
      container.visible = false;
      disposeChildren();
    } finally {
      if (resolveFn) resolveFn();
    }
  }

  function destroy() {
    if (activeTick) {
      app.ticker.remove(activeTick);
      activeTick = null;
    }
    if (pendingResolve) {
      pendingResolve();
      pendingResolve = null;
    }
    container.destroy({ children: true, context: true });
  }

  return { play, cancel, destroy, container, setColorBlindMode };
}

/**
 * Create a set of animated dice.
 */
function createDiceSet(values, color, side) {
  const dice = [];
  const count = values.length;
  const startX = side * 180;

  for (let i = 0; i < count; i++) {
    const gfx = new Graphics();
    const xOffset = startX + (Math.random() - 0.5) * 60;
    const yOffset = (i - count / 2) * DIE_GAP * 0.6;

    dice.push({
      gfx,
      finalValue: values[i],
      color,
      x: xOffset,
      y: yOffset,
      vx: -side * (6 + Math.random() * 4),
      vy: (Math.random() - 0.5) * 2,
      z: Math.random() * 10,
      up: Math.random() * INITIAL_UP_MAX,
      bc: 0,
      settled: false,
    });

    drawDieFace(gfx, color, Math.floor(Math.random() * 6) + 1);
    gfx.x = xOffset;
    gfx.y = yOffset;
  }
  return dice;
}

/** Update dice positions. Returns true when all settled. */
function updateDice(dice, speed) {
  let allSettled = true;

  for (const d of dice) {
    if (d.settled) continue;
    allSettled = false;

    // Apply velocity
    d.x += d.vx * speed;
    d.y += d.vy * speed;

    // Gravity on z-axis
    d.up -= GRAVITY * speed;
    d.z += d.up * speed;

    if (d.z < 0) {
      d.z = 0;
      d.bc++;
      if (d.bc >= MAX_BOUNCES) {
        d.settled = true;
        d.vx = 0;
        d.vy = 0;
        d.up = 0;
        // Show final value
        drawDieFace(d.gfx, d.color, d.finalValue);
      } else {
        d.up = 5 - d.bc * BOUNCE_REDUCTION;
      }
    }

    // Decelerate horizontal movement
    d.vx *= 0.95;
    d.vy *= 0.95;

    // Random face while moving
    if (!d.settled) {
      drawDieFace(d.gfx, d.color, Math.floor(Math.random() * 6) + 1);
    }

    d.gfx.x = d.x;
    d.gfx.y = d.y - d.z;
  }

  return allSettled;
}

/** Draw a single die face. */
function drawDieFace(gfx, color, value) {
  gfx.clear();

  // Die body
  gfx.roundRect(-DIE_SIZE / 2, -DIE_SIZE / 2, DIE_SIZE, DIE_SIZE, 3);
  gfx.fill(color);
  gfx.stroke({ width: 1.5, color: 0x222244 });

  // Pip positions for values 1-6
  const pips = getPipPositions(value, DIE_SIZE * 0.25);
  for (const [px, py] of pips) {
    gfx.circle(px, py, 2.5);
    gfx.fill(0xffffff);
  }
}

/** Create the total text display. */
function createTotalText(total, xPos) {
  return new Text({
    text: String(total),
    style: {
      fontFamily: 'Anton',
      fontSize: 48,
      fill: 0x000000,
      stroke: { color: 0xffffff, width: 3 },
    },
    x: xPos,
    y: -10,
    anchor: { x: 0.5, y: 0.5 },
  });
}
