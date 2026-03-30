/**
 * Bot Sandbox
 *
 * Executes community bot source code in a sandboxed vm context.
 * Prevents access to Node.js globals (require, process, fs, fetch, etc.)
 * while still allowing standard JavaScript (Math, Array, Object, etc.).
 *
 * NOTE: Node.js `vm` is not a true security sandbox — determined attackers
 * can escape via prototype chain manipulation. This is acceptable because:
 * 1. Community bot PRs require maintainer review before merge
 * 2. GitHub Actions runners are ephemeral VMs
 * 3. The tournament workflow has minimal permissions
 * For stronger isolation, consider `isolated-vm` or subprocess execution.
 *
 * @module scripts/lib/bot-sandbox
 */

import vm from 'node:vm';

/**
 * Allowed globals in the sandbox context.
 * Only pure JavaScript built-ins — no Node.js APIs.
 */
const SANDBOX_GLOBALS = {
  Math,
  Array,
  Object,
  String,
  Number,
  Boolean,
  JSON,
  Map,
  Set,
  Date,
  RegExp,
  Error,
  TypeError,
  RangeError,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  Infinity,
  NaN,
  undefined,
  // No-op console prevents bot output from polluting tournament logs
  console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
};

/**
 * Compile a bot source string into a sandboxed callable function.
 *
 * The returned function accepts a BotState and returns { from, to } or null.
 * Bot code cannot access require, process, fs, fetch, setTimeout, etc.
 *
 * @param {string} source - Bot function body (same format as bots/*.js)
 * @param {string} name - Bot display name
 * @param {number} [timeout=1000] - Execution timeout in milliseconds
 * @returns {Function} Sandboxed bot function: (state) => { from, to } | null
 */
export function compileSandboxedBot(source, name, timeout = 1000) {
  const wrappedSource = `(function(state) {\n${source}\n})`;

  // Use null prototype to block prototype chain escapes
  const context = vm.createContext(Object.assign(Object.create(null), SANDBOX_GLOBALS));
  const script = new vm.Script(wrappedSource, { filename: `${name}.js` });

  let botFn;
  try {
    botFn = script.runInContext(context, { timeout });
  } catch (err) {
    throw new Error(`Compilation failed for "${name}": ${err.message}`);
  }

  if (typeof botFn !== 'function') {
    throw new Error(`Bot "${name}" did not compile to a function`);
  }

  // Return a wrapper that enforces timeout on each call
  return function sandboxedBot(state) {
    // Inject state into the sandbox context for this call
    context.state = state;
    const callScript = new vm.Script('__botFn__(state)', {
      filename: `${name}-call.js`,
    });
    context.__botFn__ = botFn;

    try {
      return callScript.runInContext(context, { timeout });
    } catch (err) {
      if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        console.warn(`[Sandbox] Bot "${name}" timed out (${timeout}ms), ending turn`);
        return null;
      }
      throw new Error(`Bot "${name}" runtime error: ${err.message}`, { cause: err });
    } finally {
      // Clean up injected references to prevent bot code from caching sandbox internals

      delete context.state;
      delete context.__botFn__;
    }
  };
}
