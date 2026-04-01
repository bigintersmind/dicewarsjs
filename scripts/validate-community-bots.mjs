#!/usr/bin/env node

/**
 * Community Bot Validator
 *
 * Validates all bots registered in community-bots/registry.json:
 * 1. Warns if a .meta.json file is missing
 * 2. Compiles bot source in a sandboxed vm context (same as tournament)
 * 3. Runs a test match for each bot to verify runtime behavior
 *
 * Usage:
 *   node scripts/validate-community-bots.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { compileSandboxedBot } from './lib/bot-sandbox.mjs';
import { colors, pass, fail, warn } from './lib/cli-utils.mjs';

const COMMUNITY_DIR = path.resolve(import.meta.dirname, '..', 'community-bots');
const REGISTRY_PATH = path.join(COMMUNITY_DIR, 'registry.json');

// --- Load registry ---

if (!fs.existsSync(REGISTRY_PATH)) {
  console.error(`${colors.red}Registry not found:${colors.reset} ${REGISTRY_PATH}`);
  process.exit(1);
}

let registry;
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
} catch (err) {
  console.error(`${colors.red}Invalid registry JSON:${colors.reset} ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(registry)) {
  console.error(`${colors.red}Registry must be a JSON array${colors.reset}`);
  process.exit(1);
}

const activeBots = registry.filter(entry => entry.active !== false);

if (activeBots.length === 0) {
  console.log(`${colors.yellow}No active community bots found in registry.${colors.reset}`);
  process.exit(0);
}

console.log(
  `\n${colors.bold}Validating ${activeBots.length} community bot(s)...${colors.reset}\n`
);

// --- Validate each bot ---

let failures = 0;
const compiledBots = [];

for (const entry of activeBots) {
  const label = entry.id || entry.name || '<unnamed>';
  console.log(`${colors.cyan}[${label}]${colors.reset}`);

  // Check required registry fields
  if (!entry.id || !entry.name || !entry.file || !entry.author) {
    fail('Missing required fields in registry (need: id, name, file, author)');
    failures++;
    continue;
  }

  // Guard against path traversal (e.g. "../../.env")
  const botPath = path.join(COMMUNITY_DIR, entry.file);
  if (!path.resolve(botPath).startsWith(COMMUNITY_DIR + path.sep)) {
    fail(`Path traversal detected: ${entry.file}`);
    failures++;
    continue;
  }

  // Check bot source file exists
  if (!fs.existsSync(botPath)) {
    fail(`Bot file not found: ${entry.file}`);
    failures++;
    continue;
  }

  // Check meta.json exists
  const metaPath = botPath.replace(/\.js$/, '.meta.json');
  if (!fs.existsSync(metaPath)) {
    warn(`No .meta.json found (expected ${path.relative(COMMUNITY_DIR, metaPath)})`);
  }

  // Compile bot in sandbox (same environment as tournament runner)
  const source = fs.readFileSync(botPath, 'utf-8');
  let botFn;
  try {
    botFn = compileSandboxedBot(source, entry.name);
    pass('Compilation OK (sandboxed)');
  } catch (err) {
    fail(`Compilation failed: ${err.message}`);
    failures++;
    continue;
  }

  compiledBots.push({ name: entry.name, fn: botFn });
}

// --- Run a test match for each community bot ---

if (compiledBots.length > 0) {
  console.log(`\n${colors.bold}Running test matches...${colors.reset}\n`);

  const opponent = BUILT_IN_BOTS[0];

  for (const bot of compiledBots) {
    const testBots = [bot, opponent];
    try {
      const result = runMatch({ bots: testBots, seed: 42, maxTurns: 200 });
      pass(
        `${bot.name}: test match OK (${result.turnCount} turns, winner: ${result.winner !== null ? testBots[result.winner].name : 'stalemate'})`
      );
    } catch (err) {
      fail(`${bot.name}: test match failed: ${err.message}`);
      failures++;
    }
  }
}

// --- Summary ---

console.log('');
if (failures > 0) {
  console.log(`${colors.red}${colors.bold}${failures} failure(s)${colors.reset}`);
  process.exit(1);
} else {
  console.log(`${colors.green}${colors.bold}All community bots validated successfully.${colors.reset}`);
}
