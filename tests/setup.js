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

// This jsdom exposes no `window.matchMedia` at all (`window.matchMedia is not a
// function`). PreferencesManager reads '(prefers-reduced-motion: reduce)'
// through it, and GameController.isReducedMotion does the same — both inside a
// try/catch, so nothing breaks, but every jsdom test that builds a real
// manager printed a TypeError stack trace per instance and buried the warnings
// that matter (#211 item 5). A minimal MediaQueryList satisfies the read.
// `matches: false` is the answer the suite already assumes everywhere: no
// system reduced-motion preference, so effectiveReducedMotion() follows the
// stored setting rather than overriding it (PreferencesManager.test.js's
// "defers to system" case). Guarded on `window` because most files run under
// the default `node` environment, where there is none — and on the property, so
// a test that wants a real preference, or the catch branch back, can replace or
// delete it locally.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = query => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
}
