/**
 * Game Renderer
 *
 * Top-level PixiJS renderer that manages the Application, responsive scaling,
 * and child renderers (hex grid, dice, battle animation).
 *
 * @module renderer/GameRenderer
 */

import { Application, Container } from 'pixi.js';
import { HexGridRenderer } from './HexGridRenderer.js';
import { DiceRenderer } from './DiceRenderer.js';
import { createBattleAnimation } from './BattleAnimation.js';
import {
  BASE_WIDTH,
  BASE_HEIGHT,
  BG_COLOR,
  HUD_BAR_HEIGHT,
  HUD_BAR_HEIGHT_VAR,
} from './constants.js';
import { getTheme } from './themes.js';
import { createBurstEffect } from './ParticleEffect.js';
import { animateReinforcements } from './ReinforcementAnimation.js';
import { playCelebration } from './CelebrationEffect.js';

export class GameRenderer {
  constructor() {
    /** @type {Application | null} */
    this.app = null;
    /** @type {Container} Scaled root container */
    this.root = new Container();
    /** @type {HexGridRenderer | null} */
    this.hexGrid = null;
    /** @type {DiceRenderer | null} */
    this.dice = null;
    /** @type {{ play, cancel, destroy, setColorBlindMode, container } | null} */
    this.battle = null;
    /** @type {boolean} */
    this.initialized = false;
    /** @type {string | null} Current theme name (null until first setTheme call) */
    this._theme = null;
    /** @type {boolean} Color-blind mode */
    this._colorBlindMode = false;
    /** @type {'dice' | 'number'} How dice counts are shown */
    this._diceDisplayMode = 'dice';
    /** @type {{ x: number, y: number }} Saved root position for screen shake */
    this._rootOrigin = { x: 0, y: 0 };
    /** @type {boolean} Whether a screen shake is active */
    this._shaking = false;
    /** @type {boolean} Whether a drawMap pre-init warning has been logged */
    this._warnedDrawMap = false;
    /** @type {boolean} Whether an update pre-init warning has been logged */
    this._warnedUpdate = false;
    /** @type {boolean} Whether an unparseable bar-height warning has been logged */
    this._warnedBarHeight = false;
  }

  /**
   * Initialize the PixiJS application.
   *
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<GameRenderer>}
   */
  async init(canvas) {
    try {
      this.app = new Application();
      await this.app.init({
        canvas,
        resizeTo: window,
        backgroundColor: BG_COLOR,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });

      this.app.stage.addChild(this.root);

      // Create child renderers
      this.hexGrid = new HexGridRenderer(this.root);
      this.dice = new DiceRenderer(this.hexGrid.container);
      /*
       * Seed the freshly-created dice renderer with the current mode. `_diceDisplayMode`
       * is the single source of truth; without this, a later setDiceDisplayMode() call
       * with the same value short-circuits on the equality guard and the child keeps its
       * own constructor default — leaving the two out of sync.
       */
      this.dice.setDiceDisplayMode(this._diceDisplayMode);
      this.battle = createBattleAnimation(this.app);

      // Responsive scaling
      this._onResize = () => this._resize();
      this._resize();
      window.addEventListener('resize', this._onResize);

      this.initialized = true;
      return this;
    } catch (err) {
      this.destroy();
      throw err;
    }
  }

  /** Recalculate scale to fit the game board in the window. */
  _resize() {
    if (!this.app) return;
    /*
     * The ResizePlugin (`resizeTo: window`) applies window resizes on the next
     * animation frame, so on a 'resize' event `app.screen` still holds the old
     * dimensions. Force the plugin's resize now so the layout below reads
     * fresh values — otherwise the board keeps a stale scale until the next
     * resize (visible when the always-on title canvas transitions to a game).
     */
    this.app.resize();
    /*
     * How much room the HUD bar needs is the HUD's to say: under 560px it goes
     * to two rows so all eight seats fit (#222). GameHUD is the writer — it
     * measures its own bar after layout and publishes the result as
     * HUD_BAR_HEIGHT_VAR on the document root, then dispatches a 'resize' so
     * this runs against the new value. So the read happens here, at resize
     * time, and the publisher is what guarantees a resize to read it at.
     * HUD_BAR_HEIGHT is the fallback for every context with no HUD in the DOM
     * — the title screen, the tests, a headless render.
     *
     * Only a plain px length is accepted. The value feeds arithmetic, and
     * parseFloat is unit-blind: it would read '5rem' (80px at the default root
     * size) as 5, reserving almost nothing, and 'calc(80px +
     * env(safe-area-inset-bottom))' as NaN. An empty string is the ordinary
     * no-HUD case and falls back silently; anything else is a writer bug, so it
     * falls back loudly, once.
     */
    const declaredBarHeight =
      typeof document === 'undefined' || typeof getComputedStyle !== 'function'
        ? ''
        : getComputedStyle(document.documentElement).getPropertyValue(HUD_BAR_HEIGHT_VAR) || '';
    const parsedBarHeight = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(declaredBarHeight);
    if (!parsedBarHeight && declaredBarHeight.trim() !== '' && !this._warnedBarHeight) {
      console.warn(
        `[GameRenderer] ${HUD_BAR_HEIGHT_VAR} is not a px length (got "${declaredBarHeight.trim()}"); ` +
          `reserving ${HUD_BAR_HEIGHT}px instead. The value is published by GameHUD (src/ui/GameHUD.jsx).`
      );
      this._warnedBarHeight = true;
    }
    const barHeight = parsedBarHeight ? Number(parsedBarHeight[1]) : HUD_BAR_HEIGHT;
    const availableHeight = Math.max(this.app.screen.height - barHeight, 1);
    const scale = Math.min(this.app.screen.width / BASE_WIDTH, availableHeight / BASE_HEIGHT);
    this.root.scale.set(scale);
    // Center the scaled root within available area (above HUD)
    const newX = (this.app.screen.width - BASE_WIDTH * scale) / 2;
    const newY = (availableHeight - BASE_HEIGHT * scale) / 2;
    if (this._shaking) {
      this._rootOrigin.x = newX;
      this._rootOrigin.y = newY;
    }
    this.root.x = newX;
    this.root.y = newY;
  }

  /**
   * Draw a new game map.
   * @param {import('../engine/types.js').GameState} state
   */
  drawMap(state) {
    if (!this.initialized) {
      if (!this._warnedDrawMap) {
        console.warn('[GameRenderer] drawMap called before initialization');
        this._warnedDrawMap = true;
      }
      return;
    }
    this.hexGrid.drawMap(state);
    this.dice.drawAll(state);
  }

  /**
   * Update rendering after a state change.
   * @param {import('../engine/types.js').GameState} prevState
   * @param {import('../engine/types.js').GameState} nextState
   */
  update(prevState, nextState) {
    if (!this.initialized) {
      if (!this._warnedUpdate) {
        console.warn('[GameRenderer] update called before initialization');
        this._warnedUpdate = true;
      }
      return;
    }
    this.hexGrid.updateFromState(prevState, nextState);
    this.dice.drawAll(nextState);
  }

  /**
   * Convert a screen pixel position to a local position within the game map.
   * Used for hit testing.
   *
   * @param {number} screenX
   * @param {number} screenY
   * @returns {{ x: number, y: number }}
   */
  screenToMap(screenX, screenY) {
    if (!this.initialized) return { x: 0, y: 0 };

    // Convert viewport coordinates to canvas-local coordinates
    const rect = this.app.canvas.getBoundingClientRect();
    const canvasX = screenX - rect.left;
    const canvasY = screenY - rect.top;

    /*
     * Invert two transforms: the root container's responsive scale, then the
     * map container's fit-to-canvas scale (see HexGridRenderer.computeMapLayout).
     * Returns unscaled grid-local coordinates for hit testing.
     */
    const scale = this.root.scale.x;
    const mapScale = this.hexGrid.container.scale.x || 1;
    const localX = ((canvasX - this.root.x) / scale - this.hexGrid.container.x) / mapScale;
    const localY = ((canvasY - this.root.y) / scale - this.hexGrid.container.y) / mapScale;
    return { x: localX, y: localY };
  }

  /**
   * Hit test: which territory was clicked?
   * @param {number} screenX
   * @param {number} screenY
   * @returns {number} areaId (0 = no territory)
   */
  hitTest(screenX, screenY) {
    if (!this.initialized) return 0;
    const { x, y } = this.screenToMap(screenX, screenY);
    return this.hexGrid.hitTest(x, y);
  }

  /**
   * Switch the visual theme.
   * @param {string} themeName - 'dark' or 'light'
   */
  setTheme(themeName) {
    if (this._theme === themeName) return;
    this._theme = themeName;
    if (!this.initialized) return;

    const theme = getTheme(themeName);
    this.app.renderer.background.color = theme.bgColor;

    // Repaint all territories with new border colors
    if (this.hexGrid && this.hexGrid._lastState) {
      this.hexGrid.setTheme(theme);
      this.hexGrid.redrawAll();
      this.dice.drawAll(this.hexGrid._lastState);
    }
  }

  /**
   * Toggle color-blind mode.
   * @param {boolean} enabled
   */
  setColorBlindMode(enabled) {
    if (this._colorBlindMode === enabled) return;
    this._colorBlindMode = enabled;
    if (!this.initialized) return;

    if (this.hexGrid) this.hexGrid.setColorBlindMode(enabled);
    if (this.dice) this.dice.setColorBlindMode(enabled);
    if (this.battle) this.battle.setColorBlindMode(enabled);

    // Repaint if we have state
    if (this.hexGrid && this.hexGrid._lastState) {
      this.hexGrid.redrawAll();
      this.dice.drawAll(this.hexGrid._lastState);
    }
  }

  /**
   * Set how dice counts are displayed: stacked dice or a single count badge.
   * @param {'dice' | 'number'} mode
   */
  setDiceDisplayMode(mode) {
    if (this._diceDisplayMode === mode) return;
    this._diceDisplayMode = mode;
    if (!this.initialized) return;

    if (this.dice) this.dice.setDiceDisplayMode(mode);

    // Repaint if we have state
    if (this.hexGrid && this.hexGrid._lastState) {
      this.dice.drawAll(this.hexGrid._lastState);
    }
  }

  /**
   * Screen shake effect.
   * @param {number} intensity - Max pixel offset
   * @param {number} duration - Duration in ms
   * @returns {Promise<void>}
   */
  screenShake(intensity, duration) {
    if (!this.initialized || this._shaking) return Promise.resolve();
    this._shaking = true;
    this._rootOrigin.x = this.root.x;
    this._rootOrigin.y = this.root.y;

    let elapsed = 0;
    const ticker = this.app.ticker;
    const root = this.root;
    const origin = this._rootOrigin;

    return new Promise(resolve => {
      const tick = frame => {
        try {
          elapsed += frame.deltaMS;
          const t = Math.min(elapsed / duration, 1);
          const decay = 1 - t;
          root.x = origin.x + (Math.random() - 0.5) * 2 * intensity * decay;
          root.y = origin.y + (Math.random() - 0.5) * 2 * intensity * decay;

          if (t >= 1) {
            root.x = origin.x;
            root.y = origin.y;
            ticker.remove(tick);
            this._shaking = false;
            resolve();
          }
        } catch (err) {
          console.error('[GameRenderer] Screen shake tick error:', err);
          root.x = origin.x;
          root.y = origin.y;
          ticker.remove(tick);
          this._shaking = false;
          resolve();
        }
      };
      ticker.add(tick);
    });
  }

  /**
   * Play a particle burst at a territory center.
   * @param {number} areaId
   * @param {number} color
   */
  playParticleEffect(areaId, color) {
    if (!this.initialized || !this.hexGrid._lastState) return;
    const area = this.hexGrid._lastState.areas[areaId];
    if (!area) return;
    const cellPos = this.hexGrid._cellPos;
    const x = cellPos.x[area.centerCell] + 13;
    const y = cellPos.y[area.centerCell] + 9;
    createBurstEffect(this.hexGrid.container, x, y, color, this.app.ticker);
  }

  /**
   * Animate reinforcement dice distribution.
   * @param {Array<{areaId: number, oldDice: number, newDice: number}>} changes
   * @returns {Promise<void>}
   */
  animateReinforcements(changes) {
    if (!this.initialized) return Promise.resolve();
    return animateReinforcements(changes, this.hexGrid, this.app.ticker);
  }

  /**
   * Play win celebration animation.
   * @param {number} winnerId
   * @param {import('../engine/types.js').GameState} state
   * @returns {Promise<void>}
   */
  playCelebration(winnerId, state) {
    return playCelebration(winnerId, state, this);
  }

  /**
   * Get the player color for a given owner index, respecting color-blind mode.
   * @param {number} owner
   * @returns {number}
   */
  getPlayerColor(owner) {
    if (this.hexGrid) return this.hexGrid._getPlayerColor(owner);
    return 0xffffff;
  }

  /** Get the PixiJS Application instance. */
  getApp() {
    return this.app;
  }

  /** Clean up. */
  destroy() {
    window.removeEventListener('resize', this._onResize);
    if (this.battle) this.battle.destroy();
    if (this.dice) this.dice.destroy();
    if (this.hexGrid) this.hexGrid.destroy();
    if (this.app) this.app.destroy(true);
    this.initialized = false;
  }
}
