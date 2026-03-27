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
import { BASE_WIDTH, BASE_HEIGHT, BG_COLOR } from './constants.js';

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
    /** @type {{ play, destroy } | null} */
    this.battle = null;
  }

  /**
   * Initialize the PixiJS application.
   *
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<GameRenderer>}
   */
  async init(canvas) {
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
    this.battle = createBattleAnimation(this.app);

    // Responsive scaling
    this._onResize = () => this._resize();
    this._resize();
    window.addEventListener('resize', this._onResize);

    return this;
  }

  /** Recalculate scale to fit the game board in the window. */
  _resize() {
    if (!this.app) return;
    const scale = Math.min(
      this.app.screen.width / BASE_WIDTH,
      this.app.screen.height / BASE_HEIGHT
    );
    this.root.scale.set(scale);
    // Center the scaled root
    this.root.x = (this.app.screen.width - BASE_WIDTH * scale) / 2;
    this.root.y = (this.app.screen.height - BASE_HEIGHT * scale) / 2;
  }

  /**
   * Draw a new game map.
   * @param {import('../engine/types.js').GameState} state
   */
  drawMap(state) {
    this.hexGrid.drawMap(state);
    this.dice.drawAll(state);
  }

  /**
   * Update rendering after a state change.
   * @param {import('../engine/types.js').GameState} prevState
   * @param {import('../engine/types.js').GameState} nextState
   */
  update(prevState, nextState) {
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
    // Account for root container position and scale
    const scale = this.root.scale.x;
    const localX = (screenX - this.root.x) / scale - this.hexGrid.container.x;
    const localY = (screenY - this.root.y) / scale - this.hexGrid.container.y;
    return { x: localX, y: localY };
  }

  /**
   * Hit test: which territory was clicked?
   * @param {number} screenX
   * @param {number} screenY
   * @returns {number} areaId (0 = no territory)
   */
  hitTest(screenX, screenY) {
    const { x, y } = this.screenToMap(screenX, screenY);
    return this.hexGrid.hitTest(x, y);
  }

  /** Get the PixiJS Application instance. */
  getApp() {
    return this.app;
  }

  /** Clean up. */
  destroy() {
    window.removeEventListener('resize', this._onResize);
    if (this.hexGrid) this.hexGrid.destroy();
    if (this.app) this.app.destroy(true);
  }
}
