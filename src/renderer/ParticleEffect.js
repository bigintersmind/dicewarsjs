/**
 * Particle Burst Effect
 *
 * Creates a burst of small particles that fly outward and fade.
 * Used for battle victory celebrations.
 *
 * @module renderer/ParticleEffect
 */

import { Graphics } from 'pixi.js';

const PARTICLE_COUNT = 20;
const PARTICLE_SIZE = 3;
const LIFETIME_MS = 500;
const SPEED_MIN = 1.5;
const SPEED_MAX = 4;

/**
 * Play a particle burst effect at a given position.
 *
 * @param {import('pixi.js').Container} container - Parent container
 * @param {number} x - Center X position
 * @param {number} y - Center Y position
 * @param {number} color - Particle color (hex int)
 * @param {import('pixi.js').Ticker} ticker - PixiJS ticker
 * @returns {Promise<void>}
 */
export function createBurstEffect(container, x, y, color, ticker) {
  const particles = [];

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + (Math.random() - 0.5) * 0.5;
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
    const gfx = new Graphics();
    const size = PARTICLE_SIZE + Math.random() * 2;
    gfx.rect(-size / 2, -size / 2, size, size);
    gfx.fill(color);
    gfx.x = x;
    gfx.y = y;
    container.addChild(gfx);

    particles.push({
      gfx,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    });
  }

  let elapsed = 0;

  return new Promise(resolve => {
    function tick(frame) {
      try {
        elapsed += frame.deltaMS;
        const t = Math.min(elapsed / LIFETIME_MS, 1);

        for (const p of particles) {
          p.gfx.x += p.vx;
          p.gfx.y += p.vy;
          p.gfx.alpha = 1 - t;
          // Decelerate
          p.vx *= 0.96;
          p.vy *= 0.96;
        }

        if (t >= 1) {
          ticker.remove(tick);
          for (const p of particles) {
            container.removeChild(p.gfx);
            p.gfx.destroy();
          }
          resolve();
        }
      } catch (err) {
        console.error('[ParticleEffect] Animation tick error:', err);
        ticker.remove(tick);
        for (const p of particles) {
          try {
            container.removeChild(p.gfx);
            p.gfx.destroy();
          } catch {
            /* already destroyed */
          }
        }
        resolve();
      }
    }

    ticker.add(tick);
  });
}
