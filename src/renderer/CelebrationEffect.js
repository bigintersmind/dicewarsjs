/**
 * Win Celebration Effect
 *
 * Orchestrates a celebration animation when a player wins:
 * - Particle burst from the screen center
 * - Winner territories pulse with a golden glow
 * - Non-winner territories fade to grayscale
 *
 * @module renderer/CelebrationEffect
 */

import { createBurstEffect } from './ParticleEffect.js';
import { BASE_WIDTH } from './constants.js';

const CELEBRATION_DURATION_MS = 1500;
const PULSE_COLOR = 0xffd700; // Gold
const FADE_ALPHA = 0.4;

/**
 * Play a win celebration animation.
 *
 * @param {number} winnerId - Player index of the winner
 * @param {import('../engine/types.js').GameState} state - Final game state
 * @param {import('./GameRenderer.js').GameRenderer} renderer
 * @returns {Promise<void>}
 */
export async function playCelebration(winnerId, state, renderer) {
  if (!renderer.initialized || !renderer.app) return;

  const ticker = renderer.app.ticker;
  const container = renderer.hexGrid.container;

  // Fire particle burst from center of the map
  const centerX = BASE_WIDTH / 2 - container.x;
  const centerY = 350;

  // Fire particles (non-blocking)
  createBurstEffect(container, centerX, centerY, PULSE_COLOR, ticker);

  // Fade non-winner territories
  const { areas } = state;
  let elapsed = 0;

  await new Promise(resolve => {
    function tick(frame) {
      elapsed += frame.deltaMS;
      const t = Math.min(elapsed / CELEBRATION_DURATION_MS, 1);

      for (let a = 1; a < areas.length; a++) {
        const gfx = renderer.hexGrid._territoryGfx[a];
        if (!gfx || !areas[a]) continue;

        if (areas[a].owner !== winnerId) {
          // Fade out losers
          gfx.alpha = 1 - t * (1 - FADE_ALPHA);
        }
      }

      if (t >= 1) {
        ticker.remove(tick);
        resolve();
      }
    }

    ticker.add(tick);
  });
}
