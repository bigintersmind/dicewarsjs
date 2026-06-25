/**
 * PPO env-server lost-learner smoke (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * Regression guard for the two ways a learner client can be lost mid-run, both of which used to
 * hang the server forever:
 *
 *   1. DISCONNECT — the client vanishes (socket close) while the server is parked waiting for an
 *      action. The learner runs as a bot fn and `runBotDirect` swallows every bot-fn throw, so the
 *      disconnect can't unwind the match by throwing from `chooseAction`; it is detected via the
 *      worker's 'closed' signal + the `failIfLost` onTurn guard. Expected: clean EXIT 0.
 *   2. SILENT (watchdog) — the client stays connected but never sends its action bytes (a hung
 *      learner, or a hard worker death that emits no socket event). With no per-decision deadline
 *      this parks `Atomics.wait` forever; `--decision-timeout-ms` turns it into a bounded, loud
 *      abort. Expected: EXIT 1 within roughly the timeout.
 *
 * Both forks use `--episodes=0` ("run until disconnect"), the config under which the pre-fix server
 * span full self-play matches forever after the client was gone. A hang trips the kill timer → fail.
 *
 * Run: `node scripts/ppo-env-disconnect-smoke.mjs`  (exit 0 = pass). Manual transport check, kept
 * out of the vitest suite (forks a child server + live socket).
 *
 * @module scripts/ppo-env-disconnect-smoke
 */

import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseObsFrame } from './lib/obs-frame.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'ppo-env-server.mjs');
const PLAYERS = 4;
const SILENT_TIMEOUT_MS = 700;

function fail(msg) {
  process.stderr.write(`LOST-LEARNER SMOKE FAIL: ${msg}\n`);
  process.exit(1);
}

/** Spawn the server, return { child, port } once it is listening. */
async function startServer(extraArgs) {
  const child = spawn(
    process.execPath,
    [
      SERVER,
      '--port=0',
      `--players=${PLAYERS}`,
      '--learner-seat=0',
      '--opponents=ai_bc',
      '--episodes=0',
      ...extraArgs,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const port = await new Promise(resolve => {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      const m = /^PPO_ENV_SERVER LISTENING (\S+) (\d+)$/.exec(line);
      if (m) {
        rl.close();
        resolve(Number(m[2]));
      } else {
        process.stdout.write(`[server] ${line}\n`);
      }
    });
  });
  return { child, port };
}

/**
 * Run one scenario. `onSecondObs` decides what the client does when the server is parked on the
 * SECOND decision: 'destroy' the socket, or stay 'silent'. Asserts the server exits within budget
 * with the expected code.
 */
async function runScenario({ label, extraArgs, mode, expectCode, budgetMs }) {
  const { child, port } = await startServer(extraArgs);

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const killTimer = setTimeout(() => {
    if (!exited) {
      child.kill('SIGKILL');
      fail(`[${label}] server did not exit within ${budgetMs}ms — likely a hang`);
    }
  }, budgetMs);

  const socket = net.connect(port, '127.0.0.1');
  let inbound = Buffer.alloc(0);
  let obsSeen = 0;

  socket.on('data', chunk => {
    inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
    for (;;) {
      if (inbound.length < 4) return;
      const len = inbound.readUInt32LE(0);
      if (inbound.length < 4 + len) return;
      const frameBytes = inbound.subarray(4, 4 + len);
      inbound = inbound.subarray(4 + len);

      let frame;
      try {
        frame = parseObsFrame(Buffer.from(frameBytes));
      } catch (err) {
        return fail(`[${label}] frame parse error: ${err.message}`);
      }
      if (frame.terminal !== 0) continue;

      obsSeen++;
      if (obsSeen === 1) {
        const action = Buffer.allocUnsafe(4);
        action.writeInt32LE(frame.numEdges - 1, 0); // STOP — get an episode genuinely in flight
        socket.write(action);
      } else if (mode === 'destroy') {
        process.stdout.write(`[${label}] disconnecting mid-decision (no reply)\n`);
        socket.destroy();
        return;
      } else if (mode === 'desync') {
        // Reply with an out-of-range index — the server must reject it loud (fatal), not forfeit.
        const bad = Buffer.allocUnsafe(4);
        bad.writeInt32LE(frame.numEdges + 5, 0);
        process.stdout.write(`[${label}] sending out-of-range action ${frame.numEdges + 5}\n`);
        socket.write(bad);
        return;
      } else {
        // 'silent': leave the socket open and never reply — the watchdog must fire.
        process.stdout.write(`[${label}] going silent mid-decision (socket stays open)\n`);
        return;
      }
    }
  });
  socket.on('error', () => {}); // a reset after our own destroy is expected

  const start = Date.now();
  const code = await new Promise(resolve => child.on('exit', c => resolve(c)));
  clearTimeout(killTimer);
  socket.destroy();

  if (obsSeen < 2) fail(`[${label}] expected ≥2 observations before the loss, saw ${obsSeen}`);
  if (code !== expectCode) {
    fail(`[${label}] expected exit ${expectCode}, got ${code} (after ${Date.now() - start}ms)`);
  }
  process.stdout.write(
    `[${label}] PASS: server exited ${code} after ${Date.now() - start}ms (${obsSeen} obs)\n`
  );
}

async function main() {
  // 1. Clean disconnect → exit 0.
  await runScenario({
    label: 'disconnect',
    extraArgs: [],
    mode: 'destroy',
    expectCode: 0,
    budgetMs: 10_000,
  });
  // 2. Silent learner → watchdog → exit 1 within ~the timeout.
  await runScenario({
    label: 'watchdog',
    extraArgs: [`--decision-timeout-ms=${SILENT_TIMEOUT_MS}`],
    mode: 'silent',
    expectCode: 1,
    budgetMs: SILENT_TIMEOUT_MS + 6_000,
  });
  // 3. Out-of-range action (action-space desync) → loud fatal → exit 1.
  await runScenario({
    label: 'desync',
    extraArgs: [],
    mode: 'desync',
    expectCode: 1,
    budgetMs: 10_000,
  });

  process.stdout.write(
    'LOST-LEARNER SMOKE PASS: disconnect (exit 0), watchdog (exit 1), desync (exit 1) all prompt\n'
  );
  process.exit(0);
}

main().catch(err => fail(err.stack || err.message));
