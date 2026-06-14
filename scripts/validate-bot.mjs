#!/usr/bin/env node

/**
 * Bot Validation Tool
 *
 * Checks a bot file for syntax errors, compilation issues, and runtime problems.
 *
 * Usage:
 *   npm run validate-bot -- bots/my-bot.js          # validate only
 *   npm run validate-bot -- bots/my-bot.js --test   # validate + run test match
 */

import path from 'node:path';
import {
  getPositionalArg,
  hasFlag,
  loadBotSource,
  colors,
  pass,
  fail,
  warn,
} from './lib/cli-utils.mjs';
import { validateBotSource } from '../src/arena/botValidator.js';
import { compileCustomBot } from '../src/arena/customBotCompiler.js';
import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';

const args = process.argv.slice(2);
const filePath = getPositionalArg(args);
const runTest = hasFlag(args, 'test');

if (!filePath) {
  console.error('Usage: npm run validate-bot -- <file> [--test]');
  console.error('\nExamples:');
  console.error('  npm run validate-bot -- bots/my-bot.js');
  console.error('  npm run validate-bot -- bots/my-bot.js --test');
  process.exit(1);
}

const relPath = path.relative(process.cwd(), path.resolve(filePath));
console.log(`Validating: ${relPath}\n`);

let source;
try {
  source = loadBotSource(filePath);
} catch (err) {
  fail(`File read: ${err.message}`);
  process.exit(1);
}

let failures = 0;
let warnings = 0;

// Step 1: Syntax check
const syntaxResult = validateBotSource(source);
if (syntaxResult.valid) {
  pass('Syntax check');
} else {
  fail(`Syntax check: ${syntaxResult.error}`);
  failures++;
  console.log(`\nResult: ${colors.red}FAIL${colors.reset} (${failures} error)`);
  process.exit(1);
}

// Step 2: Compilation + test call
const name = path.basename(filePath, path.extname(filePath));
let compiledFn;
try {
  const compiled = compileCustomBot(source, name);
  compiledFn = compiled.fn;
  pass('Compilation');
  for (const w of compiled.warnings) {
    warn(w);
    warnings++;
  }
} catch (err) {
  fail(`Compilation: ${err.message}`);
  failures++;
  console.log(`\nResult: ${colors.red}FAIL${colors.reset} (${failures} error)`);
  process.exit(1);
}

// Step 3: Test match (optional)
if (runTest) {
  try {
    const opponents = BUILT_IN_BOTS.slice(0, 3).map(b => ({ name: b.name, fn: b.fn }));
    const bots = [{ name, fn: compiledFn }, ...opponents];
    const result = runMatch({ bots, seed: 42, maxTurns: 5 });

    const botStat = result.botStats.find(s => s.name === name);
    const errors = botStat ? botStat.errors : 0;
    const invalidMoves = botStat ? botStat.invalidMoves : 0;
    const placement = botStat ? botStat.placement : '?';

    if (errors === 0 && invalidMoves === 0) {
      pass(`Test match (placed ${placement}${ordinal(placement)}, 0 errors, 0 invalid moves)`);
    } else {
      warn(
        `Test match: ${errors} error(s), ${invalidMoves} invalid move(s), placed ${placement}${ordinal(placement)}`
      );
      warnings++;
    }
  } catch (err) {
    fail(`Test match: ${err.message}`);
    failures++;
  }
}

// Summary
console.log();
if (failures > 0) {
  console.log(
    `Result: ${colors.red}FAIL${colors.reset} (${failures} error${failures > 1 ? 's' : ''})`
  );
  process.exit(1);
} else if (warnings > 0) {
  console.log(
    `Result: ${colors.green}PASS${colors.reset} (${warnings} warning${warnings > 1 ? 's' : ''})`
  );
} else {
  console.log(`Result: ${colors.green}PASS${colors.reset}`);
}

function ordinal(n) {
  if (n === 1) return 'st';
  if (n === 2) return 'nd';
  if (n === 3) return 'rd';
  return 'th';
}
