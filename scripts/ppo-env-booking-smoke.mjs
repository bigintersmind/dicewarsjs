/**
 * PPO env-server zero-decision booking smoke (ml-bot Phase 3, task B step B2 — [D-22]/[D-23]).
 *
 * Regression guard for the B2 reordering: `league.recordResult(...)` runs ABOVE the wire
 * zero-decision gate in `ppo-env-server.mjs`, so a zero-decision episode (the learner eliminated
 * before it ever acts — no obs frame, no terminal frame) is still BOOKED into the league win-rate.
 * Booking these honest decisive losses is what lets B4's PFSP sampler up-weight the fields that
 * crush the learner fastest; if the `recordResult` call ever slips back below the `continue`, the
 * book silently drops them and the sampler quietly skews — a failure no other test catches (the
 * book is internal Node state, never on the wire; the Python e2e is structurally blind to it).
 *
 * The book is observable only via the `PPO_ENV_SERVER DONE` stats line. With the canonical
 * zero-decision anchor (7-player full field, `--seed-base=35`; pinned by `tests/ml/ppo-env.test.js`
 * and `ml/tests/test_ppo_env.py`) and `--episodes=1`, episode 0 is zero-decision: it surfaces NO
 * wire terminal (`episodes=0`) yet IS booked (`decisiveGames=1`). That pair — booked-but-not-surfaced
 * — is the discriminating signature of the reordering. If seed 35 ever stops being zero-decision
 * (engine RNG drift), this fails loud (episodes=1) → re-find a zero-decision seed and update the
 * three call sites in lockstep.
 *
 * Run: `node scripts/ppo-env-booking-smoke.mjs`  (exit 0 = pass). Manual transport check, kept out
 * of the vitest suite (forks a child server + live socket), mirroring the other ppo:*-smoke checks.
 *
 * @module scripts/ppo-env-booking-smoke
 */

import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'ppo-env-server.mjs');
const PLAYERS = 7;
// The canonical zero-decision anchor: the full 7-player training field + seed 35 (see module doc).
const OPPONENTS = 'ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive';
const SEED_BASE = 35;

function fail(msg) {
  process.stderr.write(`BOOKING SMOKE FAIL: ${msg}\n`);
  process.exit(1);
}

/** Parse the `key=value` fields off a `PPO_ENV_SERVER DONE ...` line into a number map. */
function parseDone(line) {
  const fields = {};
  for (const tok of line.split(/\s+/)) {
    const m = /^([a-zA-Z]+)=(-?[\d.]+)$/.exec(tok);
    if (m) fields[m[1]] = Number(m[2]);
  }
  return fields;
}

async function main() {
  const child = spawn(
    process.execPath,
    [
      SERVER,
      '--port=0',
      `--players=${PLAYERS}`,
      '--learner-seat=0',
      `--opponents=${OPPONENTS}`,
      `--seed-base=${SEED_BASE}`,
      '--episodes=1', // run exactly episode 0 (seed 35, zero-decision) then print DONE
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );

  const killTimer = setTimeout(() => {
    child.kill('SIGKILL');
    fail('timed out (10s) — server hung');
  }, 10_000);

  let port = null;
  let done = null;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => {
    const lis = /^PPO_ENV_SERVER LISTENING (\S+) (\d+)$/.exec(line);
    if (lis) {
      port = Number(lis[2]);
      connect(port);
      return;
    }
    if (line.startsWith('PPO_ENV_SERVER DONE')) done = parseDone(line);
    process.stdout.write(`[server] ${line}\n`);
  });

  let socket;
  function connect(p) {
    /*
     * A client must connect for the server to leave `await connected` and run the episode. The
     * zero-decision episode 0 emits no obs frame, so this socket exchanges nothing — but if seed 35
     * ever yields a decision, reply STOP so the server can finish rather than park (the assertion
     * below still fails loudly on the resulting episodes=1, flagging the seed drift).
     */
    socket = net.connect(p, '127.0.0.1');
    socket.on('data', chunk => {
      /*
       * If the server ever offers a decision (it won't on the canonical zero-decision seed), reply
       * index 0 — always legal since the server validates [0, numEdges) and numEdges >= 1. We don't
       * parse the frame here; this is purely a drift safety net so a non-zero-decision seed finishes
       * the episode rather than parking (the episodes=0 assertion below then fails loud on the drift).
       */
      void chunk;
      const action = Buffer.allocUnsafe(4);
      action.writeInt32LE(0, 0);
      socket.write(action);
    });
    socket.on('error', () => {}); // server tears the socket down on shutdown — ignore
  }

  await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(killTimer);
  rl.close();
  if (socket) socket.destroy();

  if (child.exitCode !== 0) fail(`server exited ${child.exitCode} (expected 0)`);
  if (!done) fail('never saw a PPO_ENV_SERVER DONE line');
  if (done.decisiveGames !== 1) {
    fail(
      `decisiveGames=${done.decisiveGames}, expected 1 — the zero-decision episode was NOT booked`
    );
  }
  if (!(done.bookSize > 0)) {
    fail(`bookSize=${done.bookSize}, expected > 0 — the win-rate book was not credited`);
  }
  if (done.episodes !== 0) {
    fail(
      `episodes=${done.episodes}, expected 0 — seed ${SEED_BASE} is no longer zero-decision ` +
        `(engine RNG drift). Re-find a zero-decision seed and update the JS/Python anchors in lockstep.`
    );
  }
  process.stdout.write(
    `BOOKING SMOKE PASS: zero-decision episode booked (decisiveGames=1) but surfaced no wire ` +
      `terminal (episodes=0) — the B2 reordering holds.\n`
  );
  process.exit(0);
}

main().catch(err => fail(err.stack || err.message));
