/**
 * Custom Bot Compiler
 *
 * Compiles user-provided bot source code into a callable function,
 * validates syntax and runtime behavior with a test run.
 *
 * @module arena/customBotCompiler
 */

import { validateBotSource } from './botValidator.js';
import { createBotState } from './botState.js';
import { createGame } from '../engine/GameRunner.js';

/**
 * Compile and test a custom bot from source code.
 *
 * 1. Validates syntax via `validateBotSource`
 * 2. Compiles with `new Function('state', source)`
 * 3. Runs a single test call against a generated BotState
 * 4. Validates the return value shape
 *
 * @param {string} source - Bot source code (function body)
 * @param {string} name - Bot display name
 * @returns {{ fn: Function, warnings: string[] }}
 * @throws {Error} If compilation or test fails
 */
export function compileCustomBot(source, name) {
  const syntaxResult = validateBotSource(source);
  if (!syntaxResult.valid) {
    throw new Error(syntaxResult.error);
  }

  // eslint-disable-next-line no-new-func
  const fn = new Function('state', source);

  // Generate a test state for a quick sanity check
  const testState = createGame({ seed: 1, playerCount: 2 });
  const botState = createBotState(testState, 0);

  let result;
  try {
    result = fn(botState);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Runtime error: ${message}`, { cause: err });
  }

  const warnings = [];

  if (result === null || result === undefined) {
    warnings.push('Bot returned null on test run (ends turn immediately)');
  } else if (typeof result !== 'object') {
    throw new Error(`Bot must return { from, to } or null, got ${typeof result}`);
  } else {
    if (typeof result.from !== 'number' || typeof result.to !== 'number') {
      throw new Error('Bot must return { from: number, to: number } or null');
    }
  }

  fn.botName = name;
  return { fn, warnings };
}
