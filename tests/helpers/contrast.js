/**
 * WCAG 2.x contrast arithmetic for tests.
 *
 * Contrast is a property of a pair — a colour and the surface it actually sits
 * on — and most of this UI's surfaces are translucent (`--ui-bg`,
 * `--ui-overlay-bg`, `--ui-scrim`), so the surface half of the pair only means
 * something once it has been flattened over the page (`bodyBg`). `surface()`
 * does that flattening; `contrast()` measures the pair. Tests use these to pin
 * measured ratios for both themes instead of intentions (#220).
 *
 * Deliberately tiny: hex and rgb()/rgba() in, sRGB relative luminance per the
 * WCAG 2.x definition, straight alpha compositing. Not for runtime use.
 *
 * @module tests/helpers/contrast
 */

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/**
 * Parse a CSS colour into channels. Accepts `#rgb`, `#rrggbb`, `rgb()` and
 * `rgba()` (comma syntax, as themes.js writes them), or an already-parsed
 * `{ r, g, b, a? }` object. Anything else throws, so a typo in a test never
 * measures as black.
 *
 * @param {string | { r: number, g: number, b: number, a?: number }} input
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function parseColor(input) {
  if (input && typeof input === 'object') return { a: 1, ...input };
  const s = String(input).trim();
  let m = HEX6.exec(s);
  if (m) {
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
  }
  m = HEX3.exec(s);
  if (m) {
    return {
      r: parseInt(m[1] + m[1], 16),
      g: parseInt(m[2] + m[2], 16),
      b: parseInt(m[3] + m[3], 16),
      a: 1,
    };
  }
  m = RGBA.exec(s);
  if (m) {
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  throw new Error(
    `contrast helper: unsupported colour "${input}" (use #rgb, #rrggbb, rgb() or rgba())`
  );
}

/**
 * Alpha-composite `top` onto `bottom` ("source over").
 *
 * @param {string | object} top
 * @param {string | object} bottom
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function over(top, bottom) {
  const t = parseColor(top);
  const b = parseColor(bottom);
  const a = t.a + b.a * (1 - t.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = k => (t[k] * t.a + b[k] * b.a * (1 - t.a)) / a;
  return { r: channel('r'), g: channel('g'), b: channel('b'), a };
}

/**
 * Flatten a stack of layers, bottom first, into one opaque colour — e.g.
 * `surface(theme.bodyBg, theme.uiOverlayBg)` is what the game-over text
 * really sits on. The bottom layer must be opaque or the result is undefined.
 *
 * @param {...(string | object)} layers - Bottom layer first, top layer last
 * @returns {{ r: number, g: number, b: number, a: 1 }}
 */
export function surface(...layers) {
  const [base, ...rest] = layers;
  let out = parseColor(base);
  if (out.a !== 1) {
    throw new Error('surface(): the bottom layer must be opaque (start from bodyBg)');
  }
  for (const layer of rest) out = over(layer, out);
  return out;
}

/**
 * WCAG 2.x relative luminance of an (opaque) sRGB colour.
 *
 * @param {string | object} color
 * @returns {number} 0 (black) … 1 (white)
 */
export function relativeLuminance(color) {
  const c = parseColor(color);
  const linear = v => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/**
 * WCAG 2.x contrast ratio between a foreground and the opaque surface under it.
 * A translucent foreground is composited onto the surface first; a translucent
 * surface is an error — flatten it with `surface()` so the test says what the
 * colour really sits on.
 *
 * @param {string | object} fg
 * @param {string | object} bg - Must be opaque
 * @returns {number} 1 … 21
 */
export function contrast(fg, bg) {
  const b = parseColor(bg);
  if (b.a !== 1) {
    throw new Error('contrast(): the surface must be opaque — flatten it with surface() first');
  }
  const f = parseColor(fg);
  const flatFg = f.a === 1 ? f : over(f, b);
  const l1 = relativeLuminance(flatFg);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.x AA minimums: body text, large text (≥ 24px, or ≥ 18.66px bold), UI parts. */
export const WCAG = { AA_TEXT: 4.5, AA_LARGE: 3, AA_NON_TEXT: 3 };
