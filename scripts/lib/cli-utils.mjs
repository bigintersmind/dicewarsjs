/**
 * Shared CLI Utilities
 *
 * Common argument parsing, bot loading, and output helpers
 * used by the CLI tools (new-bot, validate-bot, benchmark-bot).
 */

import fs from 'node:fs';
import path from 'node:path';
import { compileCustomBot } from '../../src/arena/customBotCompiler.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';

// --- Argument parsing ---

/**
 * Parse a --flag value pair from args array.
 * @param {string[]} args
 * @param {string} name - Flag name (without --)
 * @param {string|null} defaultValue
 * @returns {string|null}
 */
export function getArg(args, name, defaultValue = null) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return args[idx + 1];
}

/**
 * Get the first positional argument (not a flag or flag value).
 * Skips --flag and the value that follows it.
 * @param {string[]} args
 * @returns {string|null}
 */
export function getPositionalArg(args) {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg.startsWith('--')) {
      skipNext = true;
      continue;
    }
    return arg;
  }
  return null;
}

/**
 * Check if a boolean flag is present.
 * @param {string[]} args
 * @param {string} name - Flag name (without --)
 * @returns {boolean}
 */
export function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

// --- Bot loading ---

/**
 * Read a bot source file from disk.
 * @param {string} filePath - Absolute or relative path
 * @returns {string} Bot source code
 * @throws {Error} If file not found
 */
export function loadBotSource(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

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

// --- Output helpers ---

const supportsColor = process.stdout.isTTY === true;

export const colors = {
  red: supportsColor ? '\x1b[31m' : '',
  green: supportsColor ? '\x1b[32m' : '',
  yellow: supportsColor ? '\x1b[33m' : '',
  cyan: supportsColor ? '\x1b[36m' : '',
  bold: supportsColor ? '\x1b[1m' : '',
  reset: supportsColor ? '\x1b[0m' : '',
};

export function pass(msg) {
  console.log(`  ${colors.green}[PASS]${colors.reset} ${msg}`);
}

export function fail(msg) {
  console.log(`  ${colors.red}[FAIL]${colors.reset} ${msg}`);
}

export function warn(msg) {
  console.log(`  ${colors.yellow}[WARN]${colors.reset} ${msg}`);
}

/**
 * Convert kebab-case to Title Case.
 * @param {string} kebab
 * @returns {string}
 */
export function toTitleCase(kebab) {
  return kebab
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
