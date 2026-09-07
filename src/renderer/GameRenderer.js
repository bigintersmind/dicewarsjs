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
  SUPPLY_PANEL_HEIGHT_VAR,
} from './constants.js';
import { getTheme } from './themes.js';
import { createBurstEffect } from './ParticleEffect.js';
import { animateReinforcements } from './ReinforcementAnimation.js';
import { playCelebration } from './CelebrationEffect.js';

/**
 * Fit and center the fixed base canvas inside the band the chrome leaves — the
 * window minus a reservation at each end. Pure, and exported for its own unit
 * test: this is the whole of the responsive layout, and its two reservations
 * are what keep the board clear of the HUD bar below and the supply panel
 * above (a Large map on a short window is height-bound, so a band that ignored
 * the panel would slide the top rows straight under it).
 *
 * The band is floored at 1px rather than allowed to go negative: a window
 * shorter than its own chrome still has to produce a positive scale.
 *
 * @param {Object} options
 * @param {number} options.screenWidth - Canvas width in CSS pixels
 * @param {number} options.screenHeight - Canvas height in CSS pixels
 * @param {number} [options.topReserve=0] - Pixels reserved above the board
 * @param {number} [options.bottomReserve=0] - Pixels reserved below the board
 * @returns {{ scale: number, x: number, y: number }} Root transform
 */
export function computeBoardLayout({
  screenWidth,
  screenHeight,
  topReserve = 0,
  bottomReserve = 0,
}) {
  const availableHeight = Math.max(screenHeight - topReserve - bottomReserve, 1);
  const scale = Math.min(screenWidth / BASE_WIDTH, availableHeight / BASE_HEIGHT);
  return {
    scale,
    x: (screenWidth - BASE_WIDTH * scale) / 2,
    // Centered inside the band, then pushed down past whatever sits above it.
    y: topReserve + (availableHeight - BASE_HEIGHT * scale) / 2,
  };
}

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
    /**
     * Custom properties whose unparseable value has already been warned about,
     * so a resize storm never becomes a console storm. One set rather than a
     * flag per property: both reservations are read the same way.
     * @type {Set<string>}
     */
    this._warnedReserveVars = new Set();
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

  /**
   * Read one of the chrome's published reservations off the document root.
   *
   * Only a plain px length is accepted. The value feeds arithmetic, and
   * parseFloat is unit-blind: it would read '5rem' (80px at the default root
   * size) as 5, reserving almost nothing, and 'calc(80px +
   * env(safe-area-inset-bottom))' as NaN. An empty string is the ordinary
   * nobody-published-one case and falls back silently; anything else is a
   * writer bug, so it falls back loudly — once per property per renderer, so a
   * resize storm never becomes a console storm.
   *
   * @param {string} cssVar - Custom property name
   * @param {number} fallback - Reservation to use when it is absent or unusable
   * @param {string} writer - Who publishes it, for the warning
   * @returns {number} Pixels to reserve
   */
  _readReservedPx(cssVar, fallback, writer) {
    const declared =
      typeof document === 'undefined' || typeof getComputedStyle !== 'function'
        ? ''
        : getComputedStyle(document.documentElement).getPropertyValue(cssVar) || '';
    const parsed = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(declared);
    if (parsed) return Number(parsed[1]);
    if (declared.trim() !== '' && !this._warnedReserveVars.has(cssVar)) {
      console.warn(
        `[GameRenderer] ${cssVar} is not a px length (got "${declared.trim()}"); ` +
          `reserving ${fallback}px instead. The value is published by ${writer}.`
      );
      this._warnedReserveVars.add(cssVar);
    }
    return fallback;
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
     * How much room the chrome needs is the chrome's to say. Both bands are
     * published by the component that owns them and read here, at resize time:
     * GameHUD measures its bar and writes HUD_BAR_HEIGHT_VAR (under 560px it
     * goes to two rows so all eight seats fit, #222), and SupplyStatus measures
     * its panel and writes SUPPLY_PANEL_HEIGHT_VAR. Each dispatches a 'resize'
     * after publishing, which is what guarantees a resize to read it at.
     *
     * Their fallbacks differ because their absences mean different things. A
     * missing bar height is a context with no HUD in the DOM — the title
     * screen, a test, a headless render — where HUD_BAR_HEIGHT is still the
     * band the board has always left; a missing panel height is the panel not
     * being mounted, which reserves nothing.
     */
    const barHeight = this._readReservedPx(
      HUD_BAR_HEIGHT_VAR,
      HUD_BAR_HEIGHT,
      'GameHUD (src/ui/GameHUD.jsx)'
    );
    const topReserve = this._readReservedPx(
      SUPPLY_PANEL_HEIGHT_VAR,
      0,
      'SupplyStatus (src/ui/SupplyStatus.jsx)'
    );
    const {
      scale,
      x: newX,
      y: newY,
    } = computeBoardLayout({
      screenWidth: this.app.screen.width,
      screenHeight: this.app.screen.height,
      topReserve,
      bottomReserve: barHeight,
    });
    this.root.scale.set(scale);
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
