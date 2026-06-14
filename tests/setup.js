// jsdom doesn't implement canvas 2d. PixiJS probes `canvas.getContext('2d')`
// at import time (canvas blend-mode feature detection), which otherwise logs a
// noisy "Not implemented" error whenever a test imports a renderer module.
// A minimal context stub satisfies that probe (and any future renderer test).
if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.getContext.__stubbed) {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      fillStyle: '',
      globalCompositeOperation: '',
      fillRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: [0, 0, 0, 0] }),
    };
  };
  HTMLCanvasElement.prototype.getContext.__stubbed = true;
}

// Mock CreateJS
const cjs = {
  Graphics: class Graphics {
    constructor() {}
    beginFill() {
      return this;
    }
    moveTo() {
      return this;
    }
    lineTo() {
      return this;
    }
    endFill() {
      return this;
    }
    arc() {
      return this;
    }
    clear() {
      return this;
    }
    closePath() {
      return this;
    }
    beginStroke() {
      return this;
    }
    endStroke() {
      return this;
    }
    f(color) {
      return this;
    }
    s() {
      return {
        p: () => this,
      };
    }
    drawRoundRect() {
      return this;
    }
    drawRect() {
      return this;
    }
  },
  Shape: class Shape {
    constructor() {
      this.graphics = new cjs.Graphics();
      this.setBounds = () => {};
      this.setTransform = () => {};
      this.visible = true;
      this.x = 0;
      this.y = 0;
    }
  },
  Container: class Container {
    constructor() {
      this.children = [];
      this._eventHandlers = {};
    }
    addChild(...children) {
      this.children.push(...children);
    }
    addChildAt(child, index) {
      this.children.splice(index, 0, child);
    }
    removeAllChildren() {
      this.children = [];
    }
    on(event, handler) {
      if (!this._eventHandlers[event]) {
        this._eventHandlers[event] = [];
      }
      this._eventHandlers[event].push(handler);
    }
    off(event, handler) {
      if (!this._eventHandlers[event]) {
        return;
      }
      const index = this._eventHandlers[event].indexOf(handler);
      if (index > -1) {
        this._eventHandlers[event].splice(index, 1);
      }
    }
    dispatchEvent(event) {
      if (!this._eventHandlers[event]) {
        return;
      }
      this._eventHandlers[event].forEach(handler => handler());
    }
  },
  Text: class Text {
    constructor(text, font, color) {
      this.text = text;
      this.font = font;
      this.color = color;
      this.textAlign = 'center';
    }
  },
  ColorMatrixFilter: class ColorMatrixFilter {
    constructor() {}
  },
  SpriteSheet: class SpriteSheet {
    constructor() {}
  },
  Sprite: class Sprite {
    constructor(spriteSheet) {
      this.spriteSheet = spriteSheet;
    }
    gotoAndStop() {}
  },
  SpriteSheetBuilder: class SpriteSheetBuilder {
    constructor() {}
    addFrame() {}
    addMovieClip() {}
    build() {
      return {};
    }
  },
  Sound: {
    initializeDefaultPlugins: () => true,
    registerSound: () => true,
    registerSounds: () => {},
    play: () => ({}),
    stop: () => {},
    INTERRUPT_ANY: 'interrupt',
  },
  Touch: {
    isSupported: () => false,
    enable: () => {},
  },
  Stage: class Stage {
    constructor(canvas) {
      this.canvas = canvas || { width: 0, height: 0 };
      this.children = [];
    }
    enableMouseOver() {}
    update() {}
    addChild(...children) {
      this.children.push(...children);
    }
    addChildAt(child, index) {
      this.children.splice(index, 0, child);
    }
    removeAllChildren() {
      this.children = [];
    }
  },
  MovieClip: function MovieClip() {
    this.timeline = { addTween: () => {} };
    this.initialize = function () {};
  },
  Rectangle: class Rectangle {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
  },
  Tween: {
    get() {
      return {
        wait() {
          return this;
        },
        to() {
          return this;
        },
      };
    },
  },
  ColorFilter: class ColorFilter {},
  Ticker: {
    timingMode: null,
    RAF: 'raf',
    addEventListener: () => {},
  },
  LoadQueue: class LoadQueue {
    constructor() {}
    installPlugin() {}
    loadManifest() {}
    on() {}
  },
};

// Ensure MovieClip prototype can be assigned
cjs.MovieClip.prototype = {};

// Mock lib object
const lib = {
  webFontTxtFilters: {},
  properties: {
    webfonts: {},
  },
};

// Also assign to global
global.createjs = cjs;
global.cjs = cjs;
global.lib = lib;
global.images = {};
global.ss = {};
global.MC = cjs.MovieClip;
