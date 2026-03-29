/**
 * Lightweight Tween Utility
 *
 * Ticker-based property interpolation for PixiJS animations.
 * Integrates with the existing app.ticker pattern used by BattleAnimation.
 *
 * @module renderer/Tween
 */

// --- Easing functions ---

export function linear(t) {
  return t;
}

export function easeIn(t) {
  return t * t * t;
}

export function easeOut(t) {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

export function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function bounce(t) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

// --- Color interpolation ---

/**
 * Linearly interpolate between two 0xRRGGBB colors.
 *
 * @param {number} colorA - Start color
 * @param {number} colorB - End color
 * @param {number} t - Progress 0..1
 * @returns {number} Interpolated color
 */
export function lerpColor(colorA, colorB, t) {
  const rA = (colorA >> 16) & 0xff;
  const gA = (colorA >> 8) & 0xff;
  const bA = colorA & 0xff;
  const rB = (colorB >> 16) & 0xff;
  const gB = (colorB >> 8) & 0xff;
  const bB = colorB & 0xff;
  const r = Math.round(rA + (rB - rA) * t);
  const g = Math.round(gA + (gB - gA) * t);
  const b = Math.round(bA + (bB - bA) * t);
  return (r << 16) | (g << 8) | b;
}

// --- Tween ---

/**
 * Animate properties on a target object over time.
 *
 * @param {Object} target - Object whose properties to animate
 * @param {Object} to - Target values (e.g. { alpha: 0, x: 100 })
 * @param {Object} options
 * @param {number} options.duration - Duration in ms
 * @param {Function} [options.easing=easeOut] - Easing function
 * @param {Function} [options.onUpdate] - Called each frame with progress (0..1)
 * @param {Object} ticker - PixiJS Ticker instance (app.ticker)
 * @returns {{ promise: Promise<void>, cancel: () => void }}
 */
export function tween(target, to, options, ticker) {
  const { duration, easing = easeOut, onUpdate } = options;

  // Instant completion for zero/negative duration (reduced motion)
  if (duration <= 0) {
    for (const key of Object.keys(to)) {
      target[key] = to[key];
    }
    if (onUpdate) onUpdate(1);
    return { promise: Promise.resolve(), cancel: () => {} };
  }

  const from = {};
  for (const key of Object.keys(to)) {
    from[key] = target[key];
  }

  let elapsed = 0;
  let cancelled = false;
  let tickFn;

  const promise = new Promise(resolve => {
    tickFn = tick => {
      if (cancelled) {
        ticker.remove(tickFn);
        resolve();
        return;
      }

      elapsed += tick.deltaMS;
      const rawT = Math.min(elapsed / duration, 1);
      const t = easing(rawT);

      for (const key of Object.keys(to)) {
        target[key] = from[key] + (to[key] - from[key]) * t;
      }

      if (onUpdate) onUpdate(rawT);

      if (rawT >= 1) {
        ticker.remove(tickFn);
        resolve();
      }
    };

    ticker.add(tickFn);
  });

  function cancel() {
    cancelled = true;
  }

  return { promise, cancel };
}
