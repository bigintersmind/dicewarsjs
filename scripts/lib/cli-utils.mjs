/**
 * Shared CLI Utilities
 *
 * Bot loading (needs the bot registry + compiler) plus a re-export of the
 * lightweight arg/output helpers from `cli-args.mjs`. Scripts that only need the
 * lightweight helpers should import `cli-args.mjs` directly to avoid pulling the
 * bot registry (`builtInBots.js` → `ai_bc.js`) — see that file's header.
 */

import path from 'node:path';

import { compileCustomBot } from '../../src/arena/customBotCompiler.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';

import { loadBotSource } from './cli-args.mjs';

// Re-export the lightweight helpers so existing `cli-utils` importers are unaffected.
export {
  getArg,
  getPositionalArg,
  hasFlag,
  loadBotSource,
  colors,
  pass,
  fail,
  warn,
  toTitleCase,
} from './cli-args.mjs';

// --- Bot loading ---

/**
 * Compile a bot file into a callable function.
 * @param {string} filePath
 * @returns {{ name: string, fn: Function, warnings: string[] }}
 */
export function loadBot(filePath) {
  const source = loadBotSource(filePath);
  const name = path.basename(filePath, path.extname(filePath));
  const { fn, warnings } = compileCustomBot(source, name);
  return { name, fn, warnings };
}

/**
 * Resolve a bot identifier: file path or built-in bot name.
 * @param {string} identifier
 * @returns {{ name: string, fn: Function, source: 'file'|'builtin', warnings?: string[] }}
 */
export function resolveBot(identifier) {
  // Check built-in names first (case-insensitive)
  const builtin = BUILT_IN_BOTS.find(b => b.name.toLowerCase() === identifier.toLowerCase());
  if (builtin) {
    return { name: builtin.name, fn: builtin.fn, source: 'builtin' };
  }

  // Try as file path
  const { name, fn, warnings } = loadBot(identifier);
  return { name, fn, source: 'file', warnings };
}
