/**
 * Community Bot Loader (browser)
 *
 * Surfaces the curated community bots in `community-bots/registry.json` to the
 * app. The bot sources are function bodies (not ES modules), so they are bundled
 * as raw strings via `import.meta.glob(..., { query: '?raw' })` and compiled with
 * the same `compileCustomBot` the rest of the project uses.
 *
 * Two entry points:
 * - `getCommunityBotList()` — registry metadata only (no compilation), for the
 *   Title Screen picker.
 * - `loadCommunityBot(id)` — the compiled modern bot function (memoized), used by
 *   the controller when a community bot is actually selected.
 *
 * @module arena/communityBots
 */

import registry from '../../community-bots/registry.json';
import { compileCustomBot } from './customBotCompiler.js';

/**
 * Raw source of every community bot file, keyed by module path
 * (e.g. '../../community-bots/bigintersmind/connector.js'). `.meta.json` and
 * docs are excluded by the `*.js` glob; `?raw` keeps each as a string.
 */
const sources = import.meta.glob('../../community-bots/**/*.js', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Active registry entries (a bot is active unless explicitly `active: false`). */
const ACTIVE = registry.filter(entry => entry.active !== false);

/** Compiled bot functions, memoized by registry id. */
const compiledCache = new Map();

/**
 * Find the raw source string for a registry `file` (e.g. 'bigintersmind/connector.js').
 * @param {string} file
 * @returns {string | null}
 */
function sourceForFile(file) {
  const suffix = `/community-bots/${file}`;
  for (const [key, src] of Object.entries(sources)) {
    if (key.endsWith(suffix)) return src;
  }
  return null;
}

/**
 * List active community bots as picker metadata (no compilation).
 * @returns {{ id: string, name: string, author: string, description: string }[]}
 */
export function getCommunityBotList() {
  return ACTIVE.map(({ id, name, author, description }) => ({
    id,
    name,
    author,
    description,
  }));
}

/**
 * Compile and return a community bot's modern function by registry id.
 * Result is memoized so repeated selections reuse the same function.
 *
 * @param {string} id - Registry id (e.g. 'bigintersmind/connector')
 * @returns {Function} Modern bot: (BotState) → { from, to } | null
 * @throws {Error} If the id is unknown, the source is missing, or it fails to compile
 */
export function loadCommunityBot(id) {
  if (compiledCache.has(id)) return compiledCache.get(id);

  const entry = ACTIVE.find(e => e.id === id);
  if (!entry) {
    throw new Error(`Unknown community bot: ${id}`);
  }

  const src = sourceForFile(entry.file);
  if (src == null) {
    throw new Error(`Source not found for community bot ${id} (${entry.file})`);
  }

  const { fn } = compileCustomBot(src, entry.name);
  compiledCache.set(id, fn);
  return fn;
}
