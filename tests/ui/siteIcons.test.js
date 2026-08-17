/**
 * Site icon tests
 *
 * The favicon set replaced two hotlinks to the original site's icons (see
 * index.html). Guards: every icon `<link>` in index.html resolves to a file we
 * ship from public/ (nothing off-site, nothing missing), and favicon.svg is
 * really the title logo's orange die — the same path data as TitleLogo in
 * src/ui/titleArt.jsx — so the two can't silently drift apart.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');

/** `<link rel="…" href="…">` tags whose rel is an icon rel, as {rel, href}. */
function iconLinks(html) {
  return [...html.matchAll(/<link\s[^>]*>/g)]
    .map(([tag]) => ({
      rel: /\brel="([^"]*)"/.exec(tag)?.[1] ?? '',
      href: /\bhref="([^"]*)"/.exec(tag)?.[1] ?? '',
    }))
    .filter(({ rel }) => /\bicon\b/.test(rel));
}

/** The `d="…"` path data of every <path> in an SVG/JSX string, in order. */
const pathData = svg => [...svg.matchAll(/\bd="([^"]+)"/g)].map(m => m[1]);

describe('index.html icon links', () => {
  const links = iconLinks(indexHtml);

  it('declares the SVG icon, the .ico fallback and the touch icon', () => {
    const rels = links.map(l => l.rel);
    expect(rels).toContain('icon');
    expect(rels).toContain('apple-touch-icon');
    expect(links.map(l => l.href)).toEqual(
      expect.arrayContaining(['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png'])
    );
  });

  it('points every icon at a file shipped from public/, not off-site', () => {
    expect(links.length).toBeGreaterThan(0);
    for (const { href } of links) {
      expect(href).toMatch(/^\/[^/]/);
      const shipped = existsSync(resolve(root, 'public', href.slice(1)));
      expect({ href, shipped }).toEqual({ href, shipped: true });
    }
  });
});

describe('public/favicon.svg', () => {
  const favicon = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8');
  const titleArt = readFileSync(resolve(root, 'src/ui/titleArt.jsx'), 'utf8');

  it('is the title logo orange die — same path data as TitleLogo, in order', () => {
    // TitleLogo's dice are its three <g> groups: green, orange, magenta.
    const dice = [...titleArt.matchAll(/<g transform="[^"]+">([\s\S]*?)<\/g>/g)].map(m => m[1]);
    expect(dice).toHaveLength(3);
    const orangeDie = dice[1];
    expect(orangeDie).toContain('fill="#E67F02"');

    expect(pathData(favicon)).toEqual(pathData(orangeDie));
  });

  it('is a square, self-contained SVG with no rotation on the die', () => {
    expect(favicon).toMatch(/^(<!--[\s\S]*?-->\s*)?<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const [, w, h] = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(favicon);
    expect(w).toBe(h);
    expect(favicon).not.toMatch(/rotate\(/);
    // Nothing fetched or run at render time: no external refs, images, scripts.
    expect(favicon).not.toMatch(/\bhref=|url\(|<image|<script/);
  });
});
