/**
 * PPO multi-arm (concurrency) throughput probe (ml-bot Phase 3 — PERSONAS §10.7 item 6).
 *
 * The single-arm `ppo-throughput-probe.mjs` proves ONE arm's env-sim speed. This proves the
 * Wave-1 launch footprint it can't: **N training arms running at ONCE.** Wave 1 seats 3 personas
 * × N_ENVS env-servers concurrently (`N_ENVS = min(nproc-2, 12)`, one `ppo-env-server.mjs` per
 * env → 3×12 = 36 Node servers on shodan's 16 cores, past the ≤20-env footprint ever proven). It
 * runs two TIMED passes — one arm alone, then all `arms` at once — and reports the per-arm
 * throughput drop plus a go/no-go on the N_ENVS you're about to commit.
 *
 * Zero GPU: like the single-arm probe it stubs the learner action (~free) and measures only the
 * in-process opponent-sim + live encoder cost — an UPPER BOUND on realized trainer fps. So a RED
 * verdict is conclusive; GREEN means env-sim isn't the limiter (GPU/latency then decide). RUN IT
 * ON THE TARGET BOX (shodan): contention scales with core count, so a laptop run only sanity-checks
 * the tool. It is zero-GPU, so running it on shodan costs nothing but a minute of CPU.
 *
 * Usage:
 *   node scripts/ppo-arm-throughput-probe.mjs                 # 3 arms × 12 envs, realistic league
 *   node scripts/ppo-arm-throughput-probe.mjs --arms=3 --envs-per-arm=8 --seconds=20
 *   node scripts/ppo-arm-throughput-probe.mjs --target-fps=175 --margin=1.3 --json
 *
 * Flags: --arms (default 3, the Wave-1 slate size), --envs-per-arm (default 12 = shodan N_ENVS),
 * --seconds (measured window per pass, default 12), --warmup-seconds (default 2), --cooldown-seconds
 * (default 2), --opponents (a `selfplay` field string, default the realistic budget league),
 * --learner=random|stop (default random), --target-fps (per-arm realized-fps target, default 175 =
 * batch-1's figure; the 5h / 3×3M wall implies ~167/arm), --margin (env-sim headroom over target for
 * the GPU/wire the probe can't see, default 1.3), --seed-base (default 1), --learner-seat (default 0),
 * --max-turns, --max-areas, --json.
 *
 * @module scripts/ppo-arm-throughput-probe
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';

import { expandFieldTokens } from './lib/selfplay-core.mjs';
import {
  armSeedBase,
  validateArmProbeConfig,
  sumArmShards,
  summarizeContention,
  classifyThroughput,
} from './lib/ppo-arm-probe-core.mjs';
import { BC_POLICY } from '../src/ai/bcPolicyWeights.js';
import { DEFAULT_MAX_TURNS } from '../src/arena/matchRunner.js';

const WORKER_URL = new URL('./lib/ppo-arm-probe-worker.mjs', import.meta.url);

/** Realistic = the budget-relevant league (matches the single-arm probe's `realistic`). */
const DEFAULT_OPPONENTS = 'Lookahead,Strategist,Expectimax,4xBC';

const KNOWN_FLAGS = new Set([
  'arms',
  'envs-per-arm',
  'seconds',
  'warmup-seconds',
  'cooldown-seconds',
  'opponents',
  'learner',
  'target-fps',
  'margin',
  'seed-base',
  'learner-seat',
  'max-turns',
  'max-areas',
  'json',
]);

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    const key = m ? m[1] : /^--/.test(arg) ? arg.slice(2) : null;
    if (key === null)
      throw new Error(`Malformed argument "${arg}" — expected --key or --key=value.`);
    if (!KNOWN_FLAGS.has(key))
      throw new Error(`Unknown flag --${key}. Known: ${[...KNOWN_FLAGS].join(', ')}.`);
    opts[key] = m ? m[2] : 'true';
  }
  return opts;
}

/** Parse a numeric flag, defaulting when absent and rejecting a non-finite value loudly. */
function numArg(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const v = Number(opts[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key}=${opts[key]} is not a finite number.`);
  return v;
}

const mixSeed = (base, shardIndex) => (base ^ ((shardIndex + 1) * 0x9e3779b1)) >>> 0;

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData });
    worker.once('message', m => {
      worker.terminate();
      resolve(m);
    });
    worker.once('error', err => {
      worker.terminate();
      reject(err);
    });
  });
}

/**
 * Spawn `armCount` arms × `envsPerArm` workers, ALL concurrently, and return per-arm shard groups.
 * Every worker runs the same warmup/measure/cooldown window, so the whole pool contends for the
 * full measure interval. `passArm` offsets the seed layout so a later pass draws different maps.
 */
async function runPass(armCount, cfg, passArm) {
  const jobs = [];
  const armOf = [];
  for (let a = 0; a < armCount; a++) {
    for (let w = 0; w < cfg.envsPerArm; w++) {
      const arm = passArm + a;
      const shardIndex = arm * cfg.envsPerArm + w;
      jobs.push(
        runWorker({
          seatNames: cfg.seatNames,
          learner: cfg.learner,
          learnerSeat: cfg.learnerSeat,
          maxAreas: cfg.maxAreas,
          maxTurns: cfg.maxTurns,
          seedBase: armSeedBase(cfg.seedBase, arm, w, cfg.envsPerArm),
          prngSeed: mixSeed(cfg.seedBase, shardIndex),
          warmupMs: cfg.warmupMs,
          measureMs: cfg.measureMs,
          cooldownMs: cfg.cooldownMs,
        })
      );
      armOf.push(a);
    }
  }
  const shards = await Promise.all(jobs);
  const arms = Array.from({ length: armCount }, () => []);
  shards.forEach((s, i) => arms[armOf[i]].push(s));
  return arms.map(sumArmShards);
}

// --- reporting ---

const fmtInt = n => Math.round(n).toLocaleString('en-US');

function report(cfg, cores, baselineArm, contendedArms, contention, verdict) {
  const totalWorkers = cfg.arms * cfg.envsPerArm;
  const measureSec = (cfg.measureMs / 1000).toFixed(0);
  console.log(
    `\n── baseline (1 arm × ${cfg.envsPerArm} workers, uncontended) ──\n` +
      `  per-arm:  ${fmtInt(baselineArm.stepsPerSec)} steps/s  ` +
      `(${baselineArm.workers} workers, ${fmtInt(baselineArm.learnerDecisions)} decisions, ~${measureSec}s)`
  );
  const armLine = contendedArms.map((a, i) => `arm ${i} ${fmtInt(a.stepsPerSec)}`).join(' · ');
  console.log(
    `\n── contended (${cfg.arms} arms × ${cfg.envsPerArm} workers = ${totalWorkers} concurrent) ──\n` +
      `  ${armLine}  (steps/s)\n` +
      `  aggregate: ${fmtInt(contention.aggregateStepsPerSec)} steps/s  ·  ` +
      `mean/arm: ${fmtInt(contention.meanArmStepsPerSec)} steps/s`
  );
  const runAt = (100 * (1 - contention.contentionPenalty)).toFixed(1);
  console.log(
    `\n── contention ──\n` +
      `  penalty/arm:  ${(100 * contention.contentionPenalty).toFixed(1)}%  ` +
      `(each arm runs at ${runAt}% of its uncontended rate)\n` +
      `  aggregate speedup:  ${contention.aggregateSpeedup.toFixed(2)}×  ` +
      `(ideal ${cfg.arms.toFixed(2)}×, parallel efficiency ${(100 * contention.parallelEfficiency).toFixed(0)}%)\n` +
      `  oversubscription:  ${totalWorkers} workers / ${cores} cores = ${(totalWorkers / cores).toFixed(2)}×`
  );
  if (contention.aggregateSpeedup < 1) {
    // Separate from the go/no-go: even when each arm clears its per-arm floor, an aggregate below a
    // single arm means the box thrashes — the wave would finish SOONER run serially. This is exactly
    // the §8a "3 concurrent ≈ the time of one" premise failing, worth surfacing explicitly.
    console.log(
      `  ⚠ concurrency is NET-NEGATIVE (aggregate < a single arm): the wave would finish SOONER run ` +
        `serially than ${cfg.arms}-way concurrent — §8a's "≈ time of one" fails at this footprint.`
    );
  }
  console.log(
    `\n── go/no-go (target ${verdict.targetFps} fps/arm × ${verdict.margin} margin = ` +
      `${Math.round(verdict.ceiling)} env-sim floor) ──\n  ${verdict.verdict} — ${verdict.note}`
  );
  console.log(
    `  NOTE: this is the env-sim CEILING (no GPU/wire). RUN ON THE TARGET BOX — contention scales with ` +
      `core count; this ran on ${cores} cores (${totalWorkers}/${cores} = ${(totalWorkers / cores).toFixed(2)}× oversubscribed).`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const cfg = validateArmProbeConfig({
    arms: numArg(opts, 'arms', 3),
    envsPerArm: numArg(opts, 'envs-per-arm', 12),
    warmupMs: numArg(opts, 'warmup-seconds', 2) * 1000,
    measureMs: numArg(opts, 'seconds', 12) * 1000,
    cooldownMs: numArg(opts, 'cooldown-seconds', 2) * 1000,
    learner: opts.learner ?? 'random',
    targetFps: numArg(opts, 'target-fps', 175),
    margin: numArg(opts, 'margin', 1.3),
    seedBase: numArg(opts, 'seed-base', 1),
    learnerSeat: numArg(opts, 'learner-seat', 0),
    maxTurns: numArg(opts, 'max-turns', DEFAULT_MAX_TURNS),
    maxAreas: numArg(opts, 'max-areas', BC_POLICY.config.maxAreas),
  });

  const seatNames = expandFieldTokens(
    (opts.opponents ?? DEFAULT_OPPONENTS)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
  // `??` is nullish, so a PRESENT-but-empty `--opponents=` (or `--opponents=,,`) slips past the
  // default and would otherwise crash deep inside a worker ("opponents must be a non-empty array").
  // Fail loud + clean here instead — better than the sibling probe's silent fall-back to defaults,
  // which would mask an operator's empty-variable scripting bug.
  if (seatNames.length === 0) {
    throw new Error('--opponents resolved to an empty field — give at least one opponent seat.');
  }
  cfg.seatNames = seatNames;
  const playerCount = seatNames.length + 1;
  if (cfg.learnerSeat < 0 || cfg.learnerSeat >= playerCount) {
    throw new Error(
      `--learner-seat ${cfg.learnerSeat} out of range for an ${playerCount}-player game.`
    );
  }

  const cores = os.cpus().length;
  if (!opts.json) {
    console.log(
      `PPO 3-arm throughput probe · arms=${cfg.arms} · envs/arm=${cfg.envsPerArm} ` +
        `(=${cfg.arms * cfg.envsPerArm} workers) · cores=${cores} · learner=${cfg.learner} · ` +
        `measure=${cfg.measureMs / 1000}s · opponents=${opts.opponents ?? DEFAULT_OPPONENTS} (${playerCount}-FFA)`
    );
  }

  // Baseline first (1 arm alone), then the contended pass; distinct seed layout per pass so the
  // two passes draw different maps (baseline uses arm-slot `arms`, one past the contended arms).
  const [baselineArm] = await runPass(1, cfg, cfg.arms);
  const contendedArms = await runPass(cfg.arms, cfg, 0);

  const contention = summarizeContention(
    baselineArm.stepsPerSec,
    contendedArms.map(a => a.stepsPerSec)
  );
  const verdict = classifyThroughput(contention.meanArmStepsPerSec, {
    targetFps: cfg.targetFps,
    margin: cfg.margin,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          config: {
            arms: cfg.arms,
            envsPerArm: cfg.envsPerArm,
            totalWorkers: cfg.arms * cfg.envsPerArm,
            cores,
            oversubscription: (cfg.arms * cfg.envsPerArm) / cores,
            learner: cfg.learner,
            opponents: opts.opponents ?? DEFAULT_OPPONENTS,
            playerCount,
            measureSec: cfg.measureMs / 1000,
            targetFps: cfg.targetFps,
            margin: cfg.margin,
          },
          baseline: baselineArm,
          contendedArms,
          contention,
          verdict,
        },
        null,
        2
      )
    );
  } else {
    report(cfg, cores, baselineArm, contendedArms, contention, verdict);
  }

  // Non-zero exit only on a hard RED (env-sim can't feed the target) — the operator's gate.
  if (verdict.verdict === 'RED') process.exitCode = 2;
}

main().catch(err => {
  process.stderr.write(`[ppo-arm-throughput-probe] fatal: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
