/**
 * PPO env-server transport smoke check (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * End-to-end proof of the Node↔learner socket bridge: forks `ppo-env-server.mjs` in a
 * child process (it must be a separate OS process — the server's main thread blocks on
 * Atomics.wait, so an in-process client would deadlock), connects a TCP client, and
 * plays a few STOP-only episodes. Asserts every outbound frame parses (magic, encoding
 * version, dims), each non-terminal frame is answered with one i32 action, and each
 * episode ends with a terminal frame carrying a winner + reward.
 *
 * Run: `node scripts/ppo-env-smoke.mjs`  (exit 0 = pass). Not part of the vitest suite —
 * forking a child server and a live socket is a manual transport check, kept out of the
 * resource-limited unit run.
 *
 * @module scripts/ppo-env-smoke
 */

import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseObsFrame } from './lib/obs-frame.mjs';
import { ENCODING_VERSION } from '../src/arena/encodeObservation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'ppo-env-server.mjs');
const EPISODES = 3;
const PLAYERS = 4;

function fail(msg) {
  process.stderr.write(`SMOKE FAIL: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const child = spawn(
    process.execPath,
    [
      SERVER,
      '--port=0',
      `--players=${PLAYERS}`,
      '--learner-seat=0',
      '--opponents=ai_bc',
      `--episodes=${EPISODES}`,
      '--seed-base=100',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );

  const killTimer = setTimeout(() => {
    child.kill('SIGKILL');
    fail('timed out (10s) — transport hung');
  }, 10_000);

  // Wait for the LISTENING line to learn the OS-assigned port.
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

  const socket = net.connect(port, '127.0.0.1');
  let inbound = Buffer.alloc(0);
  let observations = 0;
  let terminals = 0;

  socket.on('data', chunk => {
    inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
    // Drain all complete length-prefixed frames.
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
        return fail(`frame parse error: ${err.message}`);
      }
      if (frame.encodingVersion !== ENCODING_VERSION) {
        return fail(`encodingVersion ${frame.encodingVersion} != ${ENCODING_VERSION}`);
      }
      if (frame.numEdges < 1) return fail(`numEdges ${frame.numEdges} < 1 (STOP must exist)`);

      if (frame.terminal === 0) {
        observations++;
        // Reply STOP (last index) — one i32 LE, no length prefix.
        const action = Buffer.allocUnsafe(4);
        action.writeInt32LE(frame.numEdges - 1, 0);
        socket.write(action);
      } else {
        terminals++;
        // winner === -1 is a legal stalemate; the reward must still be well-defined.
        if (frame.won !== 0 && frame.won !== 1) return fail(`terminal won=${frame.won} not 0/1`);
        if (!(frame.placement >= 0 && frame.placement <= 1)) {
          return fail(`terminal placement ${frame.placement} outside [0,1]`);
        }
        process.stdout.write(
          `[client] episode ${terminals} done: winner=${frame.winner} won=${frame.won} ` +
            `placement=${frame.placement.toFixed(3)} obs_so_far=${observations}\n`
        );
      }
    }
  });

  socket.on('error', err => fail(`socket error: ${err.message}`));

  await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(killTimer);
  socket.destroy();

  if (terminals !== EPISODES) fail(`expected ${EPISODES} terminal frames, got ${terminals}`);
  if (observations === 0) fail('no observation frames received');
  process.stdout.write(`SMOKE PASS: ${observations} observations, ${terminals} episodes\n`);
  process.exit(0);
}

main().catch(err => fail(err.stack || err.message));
