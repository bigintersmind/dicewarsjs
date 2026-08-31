/**
 * Pins the contrast helper to known WCAG values, so a wrong ratio elsewhere in
 * the suite is a wrong colour and not wrong arithmetic.
 */

import { contrast, over, parseColor, relativeLuminance, surface, WCAG } from './contrast.js';

describe('tests/helpers/contrast', () => {
  it('parses hex, short hex, rgb() and rgba()', () => {
    expect(parseColor('#1a1a2e')).toEqual({ r: 26, g: 26, b: 46, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgb(16, 16, 32)')).toEqual({ r: 16, g: 16, b: 32, a: 1 });
    expect(parseColor('rgba(16, 16, 32, 0.68)')).toEqual({ r: 16, g: 16, b: 32, a: 0.68 });
    expect(parseColor('RGBA(0,0,0,.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  it('refuses colours it cannot measure instead of guessing', () => {
    expect(() => parseColor('var(--ui-text)')).toThrow(/unsupported colour/);
    expect(() => parseColor('transparent')).toThrow(/unsupported colour/);
    expect(() => parseColor('#ffff')).toThrow(/unsupported colour/);
  });

  it('measures black on white as 21:1 in either order', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('matches the published ratio for a mid grey on white', () => {
    // #777777 on white is the textbook 4.48:1 — just under AA body text.
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(WCAG.AA_TEXT);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBe(0);
  });

  it('composites a translucent layer over an opaque one', () => {
    expect(over('rgba(0, 0, 0, 0.5)', '#ffffff')).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    // The dark theme's game-over overlay: 75% black over the navy page.
    const flat = surface('#1a1a2e', 'rgba(0, 0, 0, 0.75)');
    expect(flat.r).toBeCloseTo(6.5, 5);
    expect(flat.b).toBeCloseTo(11.5, 5);
    expect(flat.a).toBe(1);
  });

  it('flattens a whole stack bottom-first', () => {
    const flat = surface('#e8e8f0', 'rgba(240, 240, 245, 0.9)', 'rgba(0, 0, 0, 0.6)');
    // 0.6 black over the light overlay: each channel is 40% of the overlay's.
    expect(flat.r).toBeCloseTo(239.2 * 0.4, 5);
  });

  it('insists the surface be opaque', () => {
    expect(() => contrast('#ffffff', 'rgba(0, 0, 0, 0.5)')).toThrow(/opaque/);
    expect(() => surface('rgba(0, 0, 0, 0.5)', '#ffffff')).toThrow(/opaque/);
  });

  it('composites a translucent foreground before measuring it', () => {
    // Half-transparent white on black reads as mid grey, not as white.
    expect(contrast('rgba(255, 255, 255, 0.5)', '#000000')).toBeCloseTo(
      contrast('rgb(127.5, 127.5, 127.5)', '#000000'),
      5
    );
  });

  it('reproduces the #220 audit measurement: seat yellow on the light overlay', () => {
    const lightOverlay = surface('#e8e8f0', 'rgba(240, 240, 245, 0.9)');
    expect(contrast('#ffff01', lightOverlay)).toBeCloseTo(1.07, 1);
  });
});
