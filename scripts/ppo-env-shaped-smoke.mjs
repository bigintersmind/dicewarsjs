/**
 * PPO env-server SHAPED-emission transport smoke (ml-bot "bite G" / [D-28], issue #84).
 *
 * The sibling `ppo-env-smoke.mjs` exercises `main()`'s base (unshaped) wire; this one runs the REAL
 * `main()` with `--reward-shaping=1` and asserts the dense-reward path end-to-end over a live socket.
 * It is the CI-runnable complement to the hermetic `tests/ml/ppo-env-server-shaping.test.js` (which
 * pins the extracted `makeShapedEmission` glue but, since `main()` is un-exported, cannot exercise
 * `main()`'s WIRING of it) and to the node-gated Python e2e (`ml/tests/test_ppo_env.py`, which DOES
 * drive real `main()` but skips in CI — the ML CI job installs no Python `node` stack). Forking the
 * real server here closes that gap inside the JS `CI` job (`.github/workflows/ci.yml`).
 *
 * Drives an ATTACKING learner (first legal attack, else STOP) so the learner's owned-territory count
 * actually moves — a non-trivial dense signal. Asserts, against the live shaped wire:
 *   - the +8-byte shaped tail is genuinely on the wire: a BASE (unshaped) parse of the first frame
 *     trips the frame-length guard (an unshaped frame is 8 bytes short), and the `{ shaped: true }`
 *     parse then yields finite `deltaTerritory` / `elimsByLearner >= 0` — i.e. `main()` threads the
 *     tail. (`parseObsFrame` echoes its `shaped` option verbatim, so checking `shaped === true` on
 *     the shaped parse would be tautological; the length guard is the real proof.)
 *   - the FIRST decision frame of EVERY episode reports `deltaTerritory === 0` — the per-episode
 *     `shapedEmission.reset()` in the loop genuinely fires (a dropped reset leaks the prior episode's
 *     territory baseline into the next, so this would be non-zero); and
 *   - at least one frame across the run has a non-zero `deltaTerritory` (the signal is real, not an
 *     all-zero stream).
 *
 * Run: `node scripts/ppo-env-shaped-smoke.mjs` (exit 0 = pass). `--episodes=0` (run-until-disconnect)
 * so a zero-decision seed is skipped server-side and every surfaced episode is real; the client
 * disconnects after `TARGET_EPISODES` terminals (prompting a clean server exit).
 *
 * @module scripts/ppo-env-shaped-smoke
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
const TARGET_EPISODES = 3; // surface at least this many → exercises >= 2 per-episode reset boundaries
const PLAYERS = 4;

function fail(msg) {
  process.stderr.write(`SHAPED SMOKE FAIL: ${msg}\n`);
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
      '--episodes=0', // run-until-disconnect; the client stops after TARGET_EPISODES terminals
      '--seed-base=100',
      '--reward-shaping=1', // the whole point: drive main()'s shaped-emission path
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );

  const killTimer = setTimeout(() => {
    child.kill('SIGKILL');
    fail('timed out (15s) — transport hung');
  }, 15_000);

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
  let sawNonZeroDelta = false;
  // Proven once, on the first frame: a base (unshaped) parse must trip the length guard, i.e. the
  // +8-byte shaped tail is genuinely present (not just trusted from the `{ shaped: true }` parse).
  let verifiedTailPresent = false;
  // The next obs frame begins a fresh episode → its dense baseline must be 0 (reset() fired).
  let expectEpisodeStart = true;
  let disconnected = false;

  const assertShapedTail = frame => {
    if (frame.encodingVersion !== ENCODING_VERSION) {
      fail(`encodingVersion ${frame.encodingVersion} != ${ENCODING_VERSION}`);
    }
    if (frame.numEdges < 1) fail(`numEdges ${frame.numEdges} < 1 (STOP must exist)`);
    if (!Number.isFinite(frame.deltaTerritory)) {
      fail(`deltaTerritory ${frame.deltaTerritory} not finite — botState.territories read broke?`);
    }
    if (!(frame.elimsByLearner >= 0)) fail(`elimsByLearner ${frame.elimsByLearner} < 0`);
    if (frame.deltaTerritory !== 0) sawNonZeroDelta = true;
  };

  socket.on('data', chunk => {
    inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
    for (;;) {
      if (disconnected) return;
      if (inbound.length < 4) return;
      const len = inbound.readUInt32LE(0);
      if (inbound.length < 4 + len) return;
      const frameBytes = inbound.subarray(4, 4 + len);
      inbound = inbound.subarray(4 + len);

      // Prove the +8-byte shaped tail is genuinely on the wire (not merely trusted): the FIRST frame,
      // parsed as a BASE (unshaped) frame, must trip the length guard — a shaped frame is 8 bytes
      // longer than the unshaped expected length, so a base parse computes the wrong size and throws.
      if (!verifiedTailPresent) {
        let guarded = false;
        try {
          parseObsFrame(Buffer.from(frameBytes));
        } catch (err) {
          guarded = /bytes ≠ expected/.test(err.message);
        }
        if (!guarded) {
          return fail(
            'shaped tail missing — a base (unshaped) parse did not trip the length guard'
          );
        }
        verifiedTailPresent = true;
      }

      let frame;
      try {
        // The server emits shaped frames under --reward-shaping=1, so parse the +8-byte tail. A
        // base parse here would hit the frame-length guard — exactly the mismatch this smoke guards.
        frame = parseObsFrame(Buffer.from(frameBytes), { shaped: true });
      } catch (err) {
        return fail(`shaped frame parse error: ${err.message}`);
      }
      assertShapedTail(frame);

      if (frame.terminal === 0) {
        observations++;
        if (expectEpisodeStart) {
          // First decision of a new episode: the per-episode reset() makes this a fresh baseline.
          if (frame.deltaTerritory !== 0) {
            return fail(
              `episode-start deltaTerritory ${frame.deltaTerritory} != 0 — per-episode reset() ` +
                'did not fire (baseline leaked from the previous episode).'
            );
          }
          expectEpisodeStart = false;
        }
        // Attacking learner: first legal attack (slot 0) when one exists, else STOP (the lone slot).
        const action = Buffer.allocUnsafe(4);
        action.writeInt32LE(frame.numEdges > 1 ? 0 : frame.numEdges - 1, 0);
        socket.write(action);
      } else {
        terminals++;
        if (frame.won !== 0 && frame.won !== 1) return fail(`terminal won=${frame.won} not 0/1`);
        if (!(frame.placement >= 0 && frame.placement <= 1)) {
          return fail(`terminal placement ${frame.placement} outside [0,1]`);
        }
        expectEpisodeStart = true; // the next obs frame starts the next episode
        process.stdout.write(
          `[client] episode ${terminals} done: winner=${frame.winner} won=${frame.won} ` +
            `delta=${frame.deltaTerritory.toFixed(1)} elims=${frame.elimsByLearner} ` +
            `obs_so_far=${observations}\n`
        );
        if (terminals >= TARGET_EPISODES) {
          // Disconnect → the server's parked chooseAction wakes to ST_CLOSED and exits cleanly (0).
          disconnected = true;
          socket.destroy();
          return;
        }
      }
    }
  });

  socket.on('error', err => {
    if (!disconnected) fail(`socket error: ${err.message}`);
  });

  const code = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(killTimer);
  socket.destroy();

  if (terminals < TARGET_EPISODES)
    fail(`expected >= ${TARGET_EPISODES} terminals, got ${terminals}`);
  if (observations === 0) fail('no observation frames received');
  if (!sawNonZeroDelta) fail('every deltaTerritory was 0 — the dense signal never moved');
  // A client disconnect is a clean stop for the server (EnvClosed → exit 0).
  if (code !== 0) fail(`server exited ${code} after a clean client disconnect (expected 0)`);
  process.stdout.write(
    `SHAPED SMOKE PASS: ${observations} shaped observations, ${terminals} episodes, ` +
      'per-episode reset + non-trivial territory signal verified.\n'
  );
  process.exit(0);
}

main().catch(err => fail(err.stack || err.message));
