/**
 * PPO PFSP-league probe (ml-bot Phase 3 — Task B, step B5).
 *
 * Re-probes throughput AND decisive-rate on a **snapshot-heavy** field — the field the PFSP run
 * actually trains against once its pool fills with net-policy self-play snapshots (BC-forward
 * ~0.8 ms/move vs ~0.02–0.4 ms heuristic, [D-20]) — by driving the REAL `makeLeague` sampler
 * (`refresh → draw → runSelfPlayEpisode → recordResult → stats`). This is [D-23]'s "first live
 * exercise of the sampler". The Phase-3 throughput probe ([D-20]) ran a FIXED field and could not
 * exercise the league or measure decisive-rate; this is its snapshot-heavy successor.
 *
 * Two decisive-rates, never conflated:
 *   - **learner-relative** (PASS A, `terminateOnElimination:true` — the trainer's regime): the
 *     `league.stats().decisiveRate` the env-step budget locks against, measured under the same regime
 *     throughput is.
 *   - **global / [D-15] turtle** (PASS B, `terminateOnElimination:false`): `winner !== null` — the
 *     turtle-equilibrium alarm; reported, never used to size the budget.
 *
 * Snapshots are injected without the Python producer via re-export shims (see the core). The R-sweep
 * re-validates the reserve count against the real `count = players − 1` (default 6).
 *
 * Usage (local smoke):
 *   npm run ppo:league-probe -- --opponents=ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive \
 *     --players=7 --reserve-baselines=3 --pool-size=8 --learner=policy --episodes=40 --workers=1 --json
 * Usage (shodan R-sweep):
 *   node scripts/ppo-league-probe.mjs --opponents=<live CSV> --players=7 --r-sweep=0,2,3,4 \
 *     --pool-size=8 --snapshot-mix=ppo4,bc4 --learner=policy --episodes=800 --global-episodes=200 \
 *     --workers=<nproc> --json
 *
 * @module scripts/ppo-league-probe
 */

import os from 'node:os';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import { BC_POLICY as PPO_POLICY } from '../src/ai/ppoPolicyWeights.js';
import { DEFAULT_MAX_TURNS } from '../src/arena/matchRunner.js';

import {
  buildProxySpecs,
  buildSnapshotManifest,
  fieldShape,
  reserveDistinctCount,
  runLeagueProbeShard,
  mergeLeagueShards,
  steadyStateSec,
  projectBudget,
  percentilesFromHist,
  recommendMaxEdges,
  splitEpisodes,
} from './lib/ppo-league-probe-core.mjs';

const WORKER_URL = new URL('./lib/ppo-league-probe-worker.mjs', import.meta.url);
const MAX_EDGES_CAP = 1500; // matches the throughput probe — covers the all-pairs max + #247's ~1400 zone
const PCTS = [50, 90, 99, 100];

/** D-23's documented stand-in field. The REAL shodan launch CSV must be confirmed before locking. */
const DEFAULT_OPPONENTS = 'ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive';

const KNOWN_FLAGS = new Set([
  'opponents',
  'players',
  'learner-seat',
  'max-areas',
  'max-turns',
  'reserve-baselines',
  'r-sweep',
  'pfsp-epsilon',
  'pfsp-k',
  'pool-cap',
  'pool-size',
  'snapshot-mix',
  'snapshot-dir',
  'learner',
  'learner-policy',
  'episodes',
  'global-episodes',
  'workers',
  'seed-base',
  'json',
]);

export function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    const key = m ? m[1] : /^--/.test(arg) ? arg.slice(2) : null;
    if (key === null) {
      throw new Error(`Malformed argument "${arg}" — expected --key or --key=value.`);
    }
    if (!KNOWN_FLAGS.has(key)) {
      throw new Error(`Unknown flag --${key}. Known: ${[...KNOWN_FLAGS].join(', ')}.`);
    }
    opts[key] = m ? m[2] : 'true';
  }
  return opts;
}

/** Parse a numeric flag, defaulting when absent and rejecting a non-finite value loudly. */
export function numArg(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const v = Number(opts[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key}=${opts[key]} is not a finite number.`);
  return v;
}

/** Parse `--r-sweep=0,2,3,4` into non-negative ints; absent → `[fallback]`. */
export function parseRSweep(opts, fallback) {
  if (opts['r-sweep'] === undefined) return [fallback];
  return opts['r-sweep']
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const v = Number(s);
      if (!Number.isInteger(v) || v < 0) {
        throw new Error(`--r-sweep value "${s}" must be a non-negative integer.`);
      }
      return v;
    });
}

/**
 * Reject `poolCap < poolSize` up front: the league FIFO-evicts the live pool down to `poolCap`
 * (`ppo-league.mjs`), so a smaller cap would make the probe sample a SMALLER, skewed field than the
 * requested mix. (Eviction no longer unlinks shims — disk GC moved to the producer in task E / PR-3,
 * and a missing shim is now tolerated by `refresh()` regardless — but a shrunk sampleable field still
 * misreports throughput/decisive-rate.) This tool never wants eviction, so fail the launch with an
 * actionable message instead.
 *
 * @param {number} poolCap
 * @param {number} poolSize - the number of snapshots the manifest will seat (`specs.length`)
 */
export function assertPoolCapFitsPool(poolCap, poolSize) {
  if (poolCap < poolSize) {
    throw new Error(
      `--pool-cap ${poolCap} < pool size ${poolSize}: the league would FIFO-evict ` +
        `${poolSize - poolCap} snapshot(s), so the probe would sample a smaller/skewed field than ` +
        `requested (and a multi-worker R-sweep would crash on the GC'd shim). Raise --pool-cap to >= ` +
        `the pool size — this tool assumes no eviction.`
    );
  }
}

const mixSeed = (base, w) => (base ^ ((w + 1) * 0x9e3779b1)) >>> 0;

export const emptyLeagueShard = () => ({
  elapsedMs: 0,
  episodesRun: 0,
  totalTurns: 0,
  learnerDecisions: 0,
  wins: 0,
  eliminations: 0,
  globalDecisive: 0,
  hist: [],
  overflow: 0,
  botMs: {},
  botCalls: {},
  leagueStats: {
    poolSize: 0,
    loadedSnapshots: 0,
    bookSize: 0,
    decisiveGames: 0,
    truncatedGames: 0,
    decisiveRate: 0,
    noSeatBeatGames: 0,
  },
});

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData });
    let settled = false;
    const settle =
      fn =>
      (...a) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        fn(...a);
      };
    worker.once('message', settle(resolve));
    worker.once('error', settle(reject));
    /*
     * A worker can die WITHOUT an 'error' event (OOM-kill, native crash, process.exit) — that emits
     * only 'exit' with a non-zero code and would otherwise hang Promise.all forever with no diagnostic.
     * B5's per-worker footprint (the full ~4 MB policy modules + the pool) makes a hard death plausible
     * on a long shodan run, so fail the pass loudly instead.
     */
    worker.once(
      'exit',
      settle(code => {
        // Reached unsettled ⇒ the worker died before posting (a successful message settles first and
        // makes this a no-op via the `settled` guard, even though terminate() forces a non-zero exit).
        reject(new Error(`league-probe worker exited (code ${code}) before posting a result.`));
      })
    );
  });
}

/** Run one measurement pass (a single PASS A or PASS B) at a fixed R, single-thread or sharded. */
async function runPass({
  manifestPath,
  leagueOpts,
  shared,
  episodes,
  terminateOnElimination,
  record,
}) {
  const common = {
    manifestPath,
    leagueOpts,
    learner: shared.learner,
    learnerPolicySource: shared.learnerPolicySource,
    learnerSeat: shared.learnerSeat,
    maxAreas: shared.maxAreas,
    maxTurns: shared.maxTurns,
    maxEdgesCap: MAX_EDGES_CAP,
    terminateOnElimination,
    record,
    expectedSnapshots: shared.poolSize,
  };

  let shards;
  let wallMs;
  if (shared.workers <= 1) {
    const t0 = performance.now();
    shards = [
      await runLeagueProbeShard({
        ...common,
        seedBase: shared.seedBase,
        episodes,
        prngSeed: mixSeed(shared.seedBase, 0),
      }),
    ];
    wallMs = performance.now() - t0;
  } else {
    const sizes = splitEpisodes(episodes, shared.workers);
    let offset = 0;
    const t0 = performance.now();
    const promises = sizes.map((size, w) => {
      const seedBase = shared.seedBase + offset;
      offset += size;
      if (size === 0) return Promise.resolve(emptyLeagueShard());
      return runWorker({
        ...common,
        seedBase,
        episodes: size,
        prngSeed: mixSeed(shared.seedBase, w + 1),
      });
    });
    shards = await Promise.all(promises);
    wallMs = performance.now() - t0;
  }
  const merged = mergeLeagueShards(shards);

  /*
   * Throughput basis: STEADY-STATE per-shard loop time (cold start excluded), NOT the parent wall —
   * see `steadyStateSec`, which carries the full rationale and is unit-tested ([B5 review must-fix]).
   * `wallSec` is kept and reported for transparency (it bounds the steady-state number from above).
   */
  const throughputSec = steadyStateSec(shards, wallMs);
  const wallSec = wallMs / 1000;
  const edge = percentilesFromHist(merged.hist, PCTS);
  const botBreakdown = Object.keys(merged.botMs)
    .map(base => ({
      base,
      totalMs: merged.botMs[base],
      calls: merged.botCalls[base],
      avgMs: merged.botCalls[base] ? merged.botMs[base] / merged.botCalls[base] : 0,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);

  return {
    wallSec,
    throughputSec,
    episodesRun: merged.episodesRun,
    learnerDecisions: merged.learnerDecisions,
    stepsPerSec: merged.learnerDecisions / throughputSec,
    gamesPerSec: merged.episodesRun / throughputSec,
    decisionsPerGame: merged.episodesRun ? merged.learnerDecisions / merged.episodesRun : 0,
    turnsPerGame: merged.episodesRun ? merged.totalTurns / merged.episodesRun : 0,
    learnerWinPct: merged.episodesRun ? (100 * merged.wins) / merged.episodesRun : 0,
    learnerElimPct: merged.episodesRun ? (100 * merged.eliminations) / merged.episodesRun : 0,
    globalDecisiveRate: merged.episodesRun ? merged.globalDecisive / merged.episodesRun : 0,
    leagueStats: merged.leagueStats,
    edge,
    overflow: merged.overflow,
    recMaxEdges: recommendMaxEdges(edge[100]),
    botBreakdown,
  };
}

/** Run both passes for one R and assemble the per-R result. */
async function runForR({ R, manifestPath, shared }) {
  const leagueOpts = {
    baselineCsv: shared.opponents,
    count: shared.count,
    poolCap: shared.poolCap,
    reserveBaselines: R,
    pfspEpsilon: shared.pfspEpsilon,
    pfspK: shared.pfspK,
  };
  const shape = fieldShape(R, shared.count, shared.reserveDistinct);

  // PASS A — learner-relative (the trainer's terminateOnElimination:true regime; books → stats()).
  const passA = await runPass({
    manifestPath,
    leagueOpts,
    shared,
    episodes: shared.episodes,
    terminateOnElimination: true,
    record: true,
  });
  // PASS B — global / D-15 turtle (full game; not booked, to keep the regime separate).
  const passB = await runPass({
    manifestPath,
    leagueOpts,
    shared,
    episodes: shared.globalEpisodes,
    terminateOnElimination: false,
    record: false,
  });

  const budget = projectBudget(passA.stepsPerSec);
  return { R, shape, passA, passB, budget };
}

// --- reporting ---

const fmtInt = n => Math.round(n).toLocaleString('en-US');
const fmtM = n => `${(n / 1e6).toFixed(2)}M`;
const pct = x => `${(100 * x).toFixed(1)}%`;

function reportR({ R, shape, passA, passB, budget }, shared) {
  const snap = passA.botBreakdown.find(b => b.base === 'snapshot');
  console.log(
    `\n══ R=${R}  (reserve ${shape.reserveCount} baseline + ${shape.pfspCount} snapshot seats, ${shared.count} opponents) ══`
  );
  const coldBook = shared.workers > 1 ? ' [cold-book: per-worker, see 1-worker pass]' : '';
  console.log(
    `  PASS A (learner-rel, terminateOnElim:true — trainer/budget regime):` +
      `\n    throughput:  ${fmtInt(passA.stepsPerSec)} learner-steps/s · ${passA.gamesPerSec.toFixed(1)} games/s` +
      `  (${shared.workers} worker${shared.workers === 1 ? '' : 's'}, ${passA.episodesRun} games, steady ${passA.throughputSec.toFixed(1)}s / wall ${passA.wallSec.toFixed(1)}s incl. cold start)` +
      `\n    budget:      12h → ${fmtM(budget.steps12h)} env-steps  →  ${budget.verdict}` +
      `\n    decisiveRate (league.stats): ${pct(passA.leagueStats.decisiveRate)}${coldBook}` +
      `  (decisive ${passA.leagueStats.decisiveGames} / truncated ${passA.leagueStats.truncatedGames}` +
      `, noSeatBeat ${passA.leagueStats.noSeatBeatGames})` +
      `\n    per episode: ${passA.decisionsPerGame.toFixed(1)} decisions · ${passA.turnsPerGame.toFixed(1)} turns` +
      `  · learner win ${passA.learnerWinPct.toFixed(1)}% / elim ${passA.learnerElimPct.toFixed(1)}%` +
      `\n    numEdges:    p50 ${passA.edge[50]} · p90 ${passA.edge[90]} · p99 ${passA.edge[99]} · p100 ${passA.edge[100]}` +
      ` → MAX_EDGES ${passA.recMaxEdges}${passA.overflow ? ` ⚠ ${passA.overflow} overflow` : ''}` +
      `\n    snapshot per-move: ${snap ? `${snap.avgMs.toFixed(3)}ms (${fmtInt(snap.calls)} calls)` : 'n/a'}` +
      `  · pool ${passA.leagueStats.poolSize} loaded ${passA.leagueStats.loadedSnapshots} book ${passA.leagueStats.bookSize}`
  );
  console.log(
    `  PASS B (global / D-15 turtle, terminateOnElim:false): decisiveRate ${pct(passB.globalDecisiveRate)}` +
      `  (winner≠null in ${Math.round(passB.globalDecisiveRate * passB.episodesRun)}/${passB.episodesRun} full games, maxTurns ${shared.maxTurns})`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const players = numArg(opts, 'players', 7);
  const count = players - 1;
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`--players ${players} → count ${count}; need players ≥ 2.`);
  }
  const learner = opts.learner ?? 'policy';
  if (!['random', 'stop', 'policy'].includes(learner)) {
    throw new Error(`--learner must be random|stop|policy, got "${learner}".`);
  }
  const learnerPolicySource = opts['learner-policy'] ?? 'ppo';
  if (!['ppo', 'bc'].includes(learnerPolicySource)) {
    throw new Error(`--learner-policy must be ppo|bc, got "${learnerPolicySource}".`);
  }

  const shared = {
    opponents: opts.opponents ?? DEFAULT_OPPONENTS,
    count,
    learner,
    learnerPolicySource,
    learnerSeat: numArg(opts, 'learner-seat', 0),
    maxAreas: numArg(opts, 'max-areas', PPO_POLICY.config.maxAreas),
    maxTurns: numArg(opts, 'max-turns', DEFAULT_MAX_TURNS),
    poolCap: numArg(opts, 'pool-cap', 40),
    pfspEpsilon: numArg(opts, 'pfsp-epsilon', 0.05),
    pfspK: numArg(opts, 'pfsp-k', 2),
    episodes: numArg(opts, 'episodes', 200),
    globalEpisodes: numArg(opts, 'global-episodes', 100),
    workers: numArg(opts, 'workers', 1),
    seedBase: numArg(opts, 'seed-base', 1),
  };
  shared.reserveDistinct = reserveDistinctCount(shared.opponents);

  const rValues = parseRSweep(opts, numArg(opts, 'reserve-baselines', 3));
  const poolSize = numArg(opts, 'pool-size', 8);
  const specs = buildProxySpecs({ poolSize, mix: opts['snapshot-mix'] });
  shared.poolSize = specs.length; // the expected loaded-snapshot count the shard guard asserts
  assertPoolCapFitsPool(shared.poolCap, shared.poolSize); // no-eviction premise — fail loud, not silently shrink

  // Scratch dir for the proxy manifest + re-export shims (cleaned on exit).
  const scratchDir = opts['snapshot-dir'] ?? join(os.tmpdir(), `dwjs-b5-${process.pid}`);
  const manifestPath = buildSnapshotManifest(scratchDir, { specs });

  /*
   * The stand-in-field warning goes to STDERR unconditionally: the budget-locking shodan run uses
   * --json, so a stdout-only warning would be suppressed in exactly the mode where it matters most.
   * stderr never pollutes the stdout JSON artifact. ([B5 review should-fix])
   */
  if (shared.opponents === DEFAULT_OPPONENTS) {
    process.stderr.write(
      '[ppo-league-probe] ⚠ using the D-23 stand-in --opponents CSV; confirm the REAL shodan ' +
        'launch CSV before locking the budget.\n'
    );
  }
  if (shared.workers > 1) {
    process.stderr.write(
      '[ppo-league-probe] note: --workers>1 gives the multi-worker THROUGHPUT target but a ' +
        'cold-book (per-worker) decisiveRate; take the budget-locking decisiveRate from a 1-worker ' +
        'confirmation pass (the env-server warms one shared book).\n'
    );
  }

  if (!opts.json) {
    console.log(
      `PPO league probe (B5) · opponents=${shared.opponents}` +
        `\n  players=${players} (count=${count}) · learner=${learner}${learner === 'policy' ? `(${learnerPolicySource})` : ''}` +
        ` · workers=${shared.workers} · episodes A=${shared.episodes}/B=${shared.globalEpisodes}` +
        `\n  pool=${specs.length} snapshots (${opts['snapshot-mix'] ?? 'even ppo/bc'}) · poolCap=${shared.poolCap}` +
        ` · ε=${shared.pfspEpsilon} k=${shared.pfspK} · maxAreas=${shared.maxAreas} maxTurns=${shared.maxTurns}` +
        `\n  reserve baselines available (distinct, non-ai_bc): ${shared.reserveDistinct}` +
        ` — R ≥ ${shared.reserveDistinct} all collapse to ${count - shared.reserveDistinct} PFSP seats` +
        `\n  R-sweep: ${rValues.join(', ')}`
    );
  }

  const results = [];
  try {
    for (const R of rValues) {
      const r = await runForR({ R, manifestPath, shared });
      results.push(r);
      if (!opts.json) reportR(r, shared);
    }
  } finally {
    if (!opts['snapshot-dir']) rmSync(scratchDir, { recursive: true, force: true });
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          config: {
            opponents: shared.opponents,
            players,
            count,
            learner,
            learnerPolicySource,
            workers: shared.workers,
            episodes: shared.episodes,
            globalEpisodes: shared.globalEpisodes,
            poolSize: specs.length,
            poolCap: shared.poolCap,
            pfspEpsilon: shared.pfspEpsilon,
            pfspK: shared.pfspK,
            maxAreas: shared.maxAreas,
            maxTurns: shared.maxTurns,
            reserveDistinct: shared.reserveDistinct,
            seedBase: shared.seedBase,
          },
          cores: os.cpus().length,
          results: results.map(r => ({
            R: r.R,
            reserveCount: r.shape.reserveCount,
            pfspCount: r.shape.pfspCount,
            passA: {
              stepsPerSec: r.passA.stepsPerSec,
              gamesPerSec: r.passA.gamesPerSec,
              throughputSec: r.passA.throughputSec,
              wallSec: r.passA.wallSec,
              steps12h: r.budget.steps12h,
              verdict: r.budget.verdict,
              decisiveRate: r.passA.leagueStats.decisiveRate,
              decisiveGames: r.passA.leagueStats.decisiveGames,
              truncatedGames: r.passA.leagueStats.truncatedGames,
              noSeatBeatGames: r.passA.leagueStats.noSeatBeatGames,
              learnerWinPct: r.passA.learnerWinPct,
              learnerElimPct: r.passA.learnerElimPct,
              decisionsPerGame: r.passA.decisionsPerGame,
              turnsPerGame: r.passA.turnsPerGame,
              numEdges: {
                p50: r.passA.edge[50],
                p90: r.passA.edge[90],
                p99: r.passA.edge[99],
                p100: r.passA.edge[100],
                mean: r.passA.edge.mean,
              },
              recMaxEdges: r.passA.recMaxEdges,
              overflow: r.passA.overflow,
              poolSize: r.passA.leagueStats.poolSize,
              bookSize: r.passA.leagueStats.bookSize,
              botBreakdown: r.passA.botBreakdown,
            },
            passB: {
              globalDecisiveRate: r.passB.globalDecisiveRate,
              episodesRun: r.passB.episodesRun,
            },
          })),
        },
        null,
        2
      )
    );
  } else {
    console.log(
      '\nNOTE: local numbers do not lock the budget — re-run on shodan (real core count) per D-20.' +
        '\n      Throughput is the steady-state per-shard rate (cold start excluded); budget locks against' +
        '\n      the chosen R: smallest GREEN PASS-A with a healthy PASS-B global decisiveRate.' +
        '\n      Take the decisiveRate from a 1-worker pass (multi-worker is a cold per-worker book).'
    );
  }
}

/*
 * `isEntryPoint` lets the unit test import `parseArgs`/`numArg`/`parseRSweep` without running the
 * probe (mirrors ppo-env-server.mjs). `pathToFileURL` normalises argv[1] for a cross-platform compare.
 */
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch(err => {
    process.stderr.write(`[ppo-league-probe] fatal: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
