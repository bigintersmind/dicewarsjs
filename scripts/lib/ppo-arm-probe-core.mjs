/**
 * PPO multi-arm (concurrency) throughput-probe core (ml-bot Phase 3 — PERSONAS §10.7 item 6).
 *
 * The single-arm `ppo-throughput-probe.mjs` answers "how fast can ONE arm simulate env-steps?"
 * This companion answers the Wave-1 launch question it can't: **when N training arms run
 * CONCURRENTLY on one box, does each arm still simulate fast enough — or do their env-servers
 * oversubscribe the cores and collapse per-arm throughput?**
 *
 * Why it matters (PERSONAS §10.7 item 6): Wave 1 runs 3 personas × N_ENVS env-servers at once.
 * `N_ENVS = min(nproc-2, 12)` and each env is ONE `ppo-env-server.mjs` process (RUNBOOK), so
 * 3×12 = 36 Node env-servers compete for shodan's 16 cores (2.25× oversubscription) — well past
 * the ≤20-env footprint ever actually proven. RUNBOOK §8a asserts "3 concurrent runs cost ≈ the
 * time of one" because the runs are latency-bound (GPU/wire), but that only holds while the CPU
 * has env-sim headroom. This probe measures whether it still does at the real 3-arm footprint.
 *
 * Method — a CPU-bound worker-thread pool is a faithful proxy for the box's env-servers (both are
 * OS-scheduled CPU contexts contending for the same cores; the existing probe's worker uses the
 * same proxy). Two TIMED passes over the identical `runSelfPlayEpisode` path the env-server runs
 * (so the live encoder cost — v3's ~5–9% — is captured, not modeled):
 *   1. baseline: 1 arm × `envsPerArm` workers alone → the uncontended per-arm ceiling.
 *   2. contended: `arms` × `envsPerArm` workers all at once → the per-arm ceiling under load.
 * The drop between them is the contention penalty; the contended per-arm ceiling vs the trainer's
 * per-arm fps target is the go/no-go.
 *
 * One-sided-gate framing: the probe measures the env-sim CEILING (no GPU, no wire, ~free stub
 * action), which is an UPPER BOUND on realized trainer fps. So RED (ceiling below the target even
 * with no GPU cost) is CONCLUSIVE — training cannot sustain the wall. GREEN means only that env-sim
 * is not the limiter; the GPU/latency then set the realized fps (the RUNBOOK §8a regime). The
 * margin knob buffers the GPU-forward + wire (~2–10%, [D-19]) + SB3/Python per-step overhead that
 * sit on top of env-sim in the real loop and pull realized fps below this ceiling.
 *
 * @module scripts/lib/ppo-arm-probe-core
 */

import { mulberry32 } from './mulberry32.mjs';
import { makeStubChooseAction } from './ppo-probe-core.mjs';
import { runSelfPlayEpisode } from './ppo-env.mjs';

/**
 * Seed base for a given (arm, worker) shard. Shards stride far apart so their (time-bounded,
 * so unbounded-length) episode-seed runs draw disjoint, varied maps. Non-overlap here is for
 * representativeness only — throughput does not depend on it — so a large stride is plenty.
 *
 * @param {number} globalSeedBase
 * @param {number} armIndex
 * @param {number} workerIndex
 * @param {number} workersPerArm
 * @param {number} [stride=1_000_000]
 * @returns {number}
 */
export function armSeedBase(
  globalSeedBase,
  armIndex,
  workerIndex,
  workersPerArm,
  stride = 1_000_000
) {
  const shardIndex = armIndex * workersPerArm + workerIndex;
  return globalSeedBase + shardIndex * stride;
}

/**
 * Validate + normalize a probe config, throwing loudly on any nonsensical value (a silently
 * under-powered probe would green-light the wrong N_ENVS). Returns the coerced config.
 *
 * @param {Object} cfg
 * @returns {Object}
 */
export function validateArmProbeConfig(cfg) {
  const reqPosInt = (k, v) => {
    if (!Number.isInteger(v) || v <= 0)
      throw new Error(`${k} must be a positive integer, got ${v}.`);
  };
  reqPosInt('arms', cfg.arms);
  reqPosInt('envsPerArm', cfg.envsPerArm);
  for (const k of ['warmupMs', 'measureMs', 'cooldownMs']) {
    if (!Number.isFinite(cfg[k]) || cfg[k] < 0)
      throw new Error(`${k} must be a non-negative number, got ${cfg[k]}.`);
  }
  if (!(cfg.measureMs > 0)) throw new Error(`measureMs must be > 0, got ${cfg.measureMs}.`);
  if (!Number.isFinite(cfg.targetFps) || cfg.targetFps <= 0)
    throw new Error(`targetFps must be a positive number, got ${cfg.targetFps}.`);
  if (!Number.isFinite(cfg.margin) || cfg.margin < 1)
    throw new Error(`margin must be ≥ 1 (env-sim headroom over target), got ${cfg.margin}.`);
  if (cfg.learner !== 'random' && cfg.learner !== 'stop')
    throw new Error(`learner must be random|stop, got "${cfg.learner}".`);
  return cfg;
}

/**
 * Run a stub-learner self-play loop for a fixed WALL-CLOCK window so concurrent shards contend
 * for cores over the SAME interval. (Fixed-episode sharding — what the single-arm probe uses —
 * lets a fast shard finish early and stop contending, which would INFLATE the measured rate: the
 * exact effect this probe exists to detect.) Three wall phases: warmup (discard — let worker
 * spawn / fork / JIT settle across the whole pool), measure (counted), cooldown (keep contending
 * so peers still see full load through THEIR measure windows). Episodes are atomic, so an episode
 * is attributed to the phase it STARTS in and each phase overshoots by ≤ one episode; the reported
 * rate uses the TRUE elapsed wall of the counted episodes, never the nominal `measureMs`.
 *
 * @param {Object} cfg
 * @param {Array<{name:string, fn:Function}>} cfg.seats - opponent seats (playerCount-1).
 * @param {'random'|'stop'} cfg.learner
 * @param {number} cfg.learnerSeat
 * @param {number} cfg.maxAreas
 * @param {number} cfg.maxTurns
 * @param {number} cfg.seedBase
 * @param {number} cfg.prngSeed
 * @param {number} cfg.warmupMs
 * @param {number} cfg.measureMs
 * @param {number} cfg.cooldownMs
 * @param {() => number} [cfg.nowFn=performance.now] - injectable clock (tests).
 * @param {Function} [cfg.episodeFn=runSelfPlayEpisode] - injectable episode runner (tests use a
 *   fake with a KNOWN decision count so the phase-accounting/exclusion contract is deterministic;
 *   the real `runSelfPlayEpisode` is not bit-deterministic — heuristic opponents roll unseeded).
 * @returns {{learnerDecisions:number, measuredEpisodes:number, elapsedMs:number,
 *   stepsPerSec:number, warmupEpisodes:number, cooldownEpisodes:number}}
 */
export function runTimedProbeShard({
  seats,
  learner,
  learnerSeat,
  maxAreas,
  maxTurns,
  seedBase,
  prngSeed,
  warmupMs,
  measureMs,
  cooldownMs,
  nowFn = () => performance.now(),
  episodeFn = runSelfPlayEpisode,
}) {
  const prng = mulberry32(prngSeed);
  const chooseAction = makeStubChooseAction(learner, prng);
  let counting = false;
  let learnerDecisions = 0;
  const onObservation = () => {
    if (counting) learnerDecisions += 1;
  };

  let seed = seedBase;
  const runEpisode = () => {
    episodeFn({
      seed: seed++,
      opponents: seats,
      learnerSeat,
      maxAreas,
      maxTurns,
      chooseAction,
      onObservation,
      terminateOnElimination: true,
    });
  };

  // Phase 1 — warmup (not counted): spin until the pool is warm.
  const t0 = nowFn();
  let warmupEpisodes = 0;
  while (nowFn() - t0 < warmupMs) {
    runEpisode();
    warmupEpisodes += 1;
  }

  // Phase 2 — measure (counted): the true elapsed of these episodes is the throughput denominator.
  counting = true;
  const mStart = nowFn();
  let measuredEpisodes = 0;
  do {
    runEpisode();
    measuredEpisodes += 1;
  } while (nowFn() - mStart < measureMs);
  const elapsedMs = nowFn() - mStart;
  counting = false;

  // Phase 3 — cooldown (not counted): keep loading the cores so peers finish under full contention.
  const cStart = nowFn();
  let cooldownEpisodes = 0;
  while (nowFn() - cStart < cooldownMs) {
    runEpisode();
    cooldownEpisodes += 1;
  }

  return {
    learnerDecisions,
    measuredEpisodes,
    elapsedMs,
    stepsPerSec: elapsedMs > 0 ? (learnerDecisions * 1000) / elapsedMs : 0,
    warmupEpisodes,
    cooldownEpisodes,
  };
}

/**
 * Sum a set of concurrent shard rates into one arm's throughput. The shards ran over the same
 * wall window, so their steps/sec (a rate) add: aggregate arm rate = Σ shard rates.
 *
 * @param {Array<{stepsPerSec:number, learnerDecisions:number}>} shards
 * @returns {{stepsPerSec:number, learnerDecisions:number, workers:number}}
 */
export function sumArmShards(shards) {
  return {
    stepsPerSec: shards.reduce((a, s) => a + s.stepsPerSec, 0),
    learnerDecisions: shards.reduce((a, s) => a + s.learnerDecisions, 0),
    workers: shards.length,
  };
}

/**
 * Contention summary: how much each arm slows, and how well the box parallelizes, going from one
 * arm alone to `arms` arms at once.
 *
 * @param {number} baselineArmStepsPerSec - one arm's uncontended steps/sec.
 * @param {number[]} contendedArmStepsPerSec - per-arm steps/sec under the full concurrent load.
 * @returns {{arms:number, baselineArmStepsPerSec:number, contendedArmStepsPerSec:number[],
 *   aggregateStepsPerSec:number, meanArmStepsPerSec:number, contentionPenalty:number,
 *   aggregateSpeedup:number, parallelEfficiency:number}}
 */
export function summarizeContention(baselineArmStepsPerSec, contendedArmStepsPerSec) {
  if (!(baselineArmStepsPerSec > 0)) {
    throw new Error(
      `summarizeContention: baselineArmStepsPerSec must be > 0, got ${baselineArmStepsPerSec}.`
    );
  }
  if (!Array.isArray(contendedArmStepsPerSec) || contendedArmStepsPerSec.length === 0) {
    throw new Error('summarizeContention: contendedArmStepsPerSec must be a non-empty array.');
  }
  const arms = contendedArmStepsPerSec.length;
  const aggregate = contendedArmStepsPerSec.reduce((a, b) => a + b, 0);
  const meanArm = aggregate / arms;
  return {
    arms,
    baselineArmStepsPerSec,
    contendedArmStepsPerSec,
    aggregateStepsPerSec: aggregate,
    meanArmStepsPerSec: meanArm,
    // fraction each arm loses to the OTHER (arms-1) arms' contention (0 = no penalty; 1 = fully starved).
    contentionPenalty: 1 - meanArm / baselineArmStepsPerSec,
    // total useful work vs one arm alone (ideal = arms, i.e. perfect scaling).
    aggregateSpeedup: aggregate / baselineArmStepsPerSec,
    // aggregateSpeedup normalized to [0,1] (ideal = 1).
    parallelEfficiency: aggregate / baselineArmStepsPerSec / arms,
  };
}

/**
 * Go/no-go on committing this N_ENVS for the concurrent wave, from the CONTENDED per-arm env-sim
 * ceiling. One-sided gate (see the module header): RED (ceiling below target even with zero GPU
 * cost) is conclusive; GREEN says only that env-sim isn't the limiter, so the GPU/latency set the
 * realized fps. `margin` buffers the GPU-forward + wire + SB3 overhead the probe doesn't measure.
 *
 * @param {number} meanArmStepsPerSec - contended per-arm ceiling.
 * @param {{targetFps:number, margin:number}} opts
 * @returns {{verdict:'GREEN'|'YELLOW'|'RED', targetFps:number, margin:number, headroom:number,
 *   floor:number, ceiling:number, note:string}}
 */
export function classifyThroughput(meanArmStepsPerSec, { targetFps, margin }) {
  const floor = targetFps; // realized fps must reach this per arm to hold the wall estimate.
  const ceiling = targetFps * margin; // env-sim must clear this to leave room for GPU/wire on top.
  const headroom = meanArmStepsPerSec / targetFps; // ×target the env-sim ceiling reaches.
  let verdict;
  let note;
  if (meanArmStepsPerSec >= ceiling) {
    verdict = 'GREEN';
    note =
      `env-sim ceiling ${meanArmStepsPerSec.toFixed(0)}/arm ≥ ${margin}× target (${ceiling.toFixed(0)}); ` +
      `env-sim is not the bottleneck at this footprint — commit N_ENVS. GPU/latency set the realized fps.`;
  } else if (meanArmStepsPerSec >= floor) {
    verdict = 'YELLOW';
    note =
      `env-sim ceiling ${meanArmStepsPerSec.toFixed(0)}/arm clears the target (${floor.toFixed(0)}) but not the ` +
      `${margin}× margin (${ceiling.toFixed(0)}) — no room for GPU/wire overhead. Trim N_ENVS, stagger arms, ` +
      `or accept a slower wall, then re-probe.`;
  } else {
    verdict = 'RED';
    note =
      `env-sim ceiling ${meanArmStepsPerSec.toFixed(0)}/arm is BELOW the target (${floor.toFixed(0)}) with zero GPU ` +
      `cost — the wall blows out at this footprint. Reduce N_ENVS (fewer env-servers/arm) or run fewer arms concurrently.`;
  }
  return { verdict, targetFps, margin, headroom, floor, ceiling, note };
}
