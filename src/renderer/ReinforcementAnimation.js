/**
 * Reinforcement Animation
 *
 * Animates dice count changes when reinforcements are distributed
 * at the end of a turn. Briefly flashes territory borders gold.
 *
 * @module renderer/ReinforcementAnimation
 */

import { Graphics } from 'pixi.js';
import { HEX_VERTEX_X, HEX_VERTEX_Y } from './constants.js';

const FLASH_COLOR = 0xffd700; // Gold
const FLASH_DURATION_MS = 200;
const STAGGER_MS = 40;

/**
 * Animate reinforcement distribution across territories.
 *
 * @param {Array<{areaId: number, oldDice: number, newDice: number}>} changes
 * @param {import('./HexGridRenderer.js').HexGridRenderer} hexGrid
 * @param {import('pixi.js').Ticker} ticker
 * @returns {Promise<void>}
 */
export function animateReinforcements(changes, hexGrid, ticker) {
  if (changes.length === 0) return Promise.resolve();

  const totalDuration = changes.length * STAGGER_MS + FLASH_DURATION_MS;
  let elapsed = 0;

  // Track which territories are currently flashing
  const flashStates = changes.map((_, i) => ({
    startTime: i * STAGGER_MS,
    flashing: false,
    done: false,
  }));

  return new Promise(resolve => {
    function tick(frame) {
      try {
        elapsed += frame.deltaMS;

        for (let i = 0; i < changes.length; i++) {
          const fs = flashStates[i];
          if (fs.done) continue;

          if (elapsed >= fs.startTime && !fs.flashing) {
            fs.flashing = true;
            // Flash the border gold
            const gfx = hexGrid._territoryGfx[changes[i].areaId];
            if (gfx) {
              const border = hexGrid._borders[changes[i].areaId];
              if (border) {
                flashTerritoryBorder(gfx, border, hexGrid._cellPos, FLASH_COLOR);
              }
            }
          }

          if (elapsed >= fs.startTime + FLASH_DURATION_MS && !fs.done) {
            fs.done = true;
            // Restore normal appearance
            hexGrid.redrawTerritory(changes[i].areaId, hexGrid._lastState);
          }
        }

        if (elapsed >= totalDuration) {
          ticker.remove(tick);
          resolve();
        }
      } catch (err) {
        console.error('[ReinforcementAnimation] Animation tick error:', err);
        ticker.remove(tick);
        resolve();
      }
    }

    ticker.add(tick);
  });
}

/**
 * Briefly flash a territory's border a different color.
 * Draws a thick stroke over the existing territory.
 */
function flashTerritoryBorder(gfx, border, cellPos, color) {
  if (border.length < 2) return;

  const flashGfx = new Graphics();
  const first = border[0];
  const points = [
    cellPos.x[first.cell] + HEX_VERTEX_X[first.dir],
    cellPos.y[first.cell] + HEX_VERTEX_Y[first.dir],
  ];

  for (let i = 0; i < border.length - 1; i++) {
    const seg = border[i];
    points.push(
      cellPos.x[seg.cell] + HEX_VERTEX_X[seg.dir + 1],
      cellPos.y[seg.cell] + HEX_VERTEX_Y[seg.dir + 1]
    );
  }

  flashGfx.poly(points, true);
  flashGfx.stroke({ width: 6, color, join: 'round', cap: 'round' });

  gfx.parent.addChild(flashGfx);

  // Auto-cleanup after a short delay
  setTimeout(() => {
    try {
      if (flashGfx.parent) {
        flashGfx.parent.removeChild(flashGfx);
      }
      flashGfx.destroy();
    } catch (err) {
      console.error('[ReinforcementAnimation] Flash cleanup error:', err);
    }
  }, FLASH_DURATION_MS + 50);
}
