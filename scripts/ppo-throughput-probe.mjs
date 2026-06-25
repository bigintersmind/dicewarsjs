/**
 * PPO throughput + action-space probe (ml-bot Phase 3 — [D-19], tracer step 3).
 *
 * Runs many self-play episodes with a stub learner against the real opponent league and
 * reports (1) learner-steps/sec and (2) the per-decision action-count (`numEdges`)
 * distribution. This is the existential, decision-independent measurement [D-19] flagged as
 * UNPROVEN: the PPO loop simulates the learner's opponents IN-PROCESS, so reachability of the
 * env-step budget hinges on this number — not on the wire (~2–10% of a step). The numEdges
 * distribution sizes `MAX_EDGES` (the fixed action-space pad for MaskablePPO).
 *
 * No socket: calls the env core (`runSelfPlayEpisode`) directly with a synchronous stub
 * `chooseAction`, isolating the dominant opponent-simulation cost.
 *
 * Usage:
 *   node scripts/ppo-throughput-probe.mjs            # default matrix: worst-case + realistic
 *   node scripts/ppo-throughput-probe.mjs --opponents=7xLookahead --workers=6 --episodes=300
 *   node scripts/ppo-throughput-probe.mjs --learner=stop --json
 *
 * Flags: --opponents (a `selfplay` field string, e.g. `7xLookahead` or
 * `Lookahead,Strategist,Expectimax,4xBC`; omit to run both named leagues), --learner=random|stop,
 * --episodes (TOTAL, sharded across workers), --workers (default 1), --seed-base (default 1),
 * --learner-seat (default 0), --max-turns (default 500), --max-areas (default BC maxAreas),
 * --json.
 *
 * @module scripts/ppo-throughput-probe
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';

import { resolveBotsByName, expandFieldTokens } from './lib/selfplay-core.mjs';
import {
  runProbeShard,
  mergeShards,
  splitEpisodes,
  percentilesFromHist,
  recommendMaxEdges,
} from './lib/ppo-probe-core.mjs';
import { BC_POLICY } from '../src/ai/bcPolicyWeights.js';

const WORKER_URL = new URL('./lib/ppo-probe-worker.mjs', import.meta.url);
const MAX_EDGES_CAP = 1500; // covers the ~992 all-pairs max + sb3-contrib #247's ~1400 zone
const PCTS = [50, 90, 99, 100];

/** Named leagues run by default (no --opponents). Realistic = the budget-relevant number. */
const NAMED_LEAGUES = [
  { key: 'worst', label: 'worst-case (7×Lookahead)', opponents: '7xLookahead' },
  {
    key: 'realistic',
    label: 'realistic (Lookahead, Strategist, Expectimax, 4×BC)',
    opponents: 'Lookahead,Strategist,Expectimax,4xBC',
  },
];

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) opts[m[1]] = m[2];
    else if (/^--/.test(arg)) opts[arg.slice(2)] = 'true';
  }
  return opts;
}

const mixSeed = (base, w) => (base ^ ((w + 1) * 0x9e3779b1)) >>> 0;

const emptyShard = () => ({
  elapsedMs: 0,
  episodesRun: 0,
  totalTurns: 0,
  learnerDecisions: 0,
  wins: 0,
  eliminations: 0,
  hist: new Array(MAX_EDGES_CAP).fill(0),
  overflow: 0,
  botMs: {},
  botCalls: {},
});

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

async function runLeague(opponentsStr, cfg) {
  const seatNames = expandFieldTokens(
    opponentsStr
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
  const playerCount = seatNames.length + 1;
  if (cfg.learnerSeat < 0 || cfg.learnerSeat >= playerCount) {
    throw new Error(
      `--learner-seat ${cfg.learnerSeat} out of range for an ${playerCount}-player game.`
    );
  }

  let merged;
  let wallMs;
  if (cfg.workers <= 1) {
    const seats = resolveBotsByName(seatNames).map(b => ({ name: b.name, fn: b.fn }));
    const t0 = performance.now();
    const shard = runProbeShard({
      seats,
      learner: cfg.learner,
      learnerSeat: cfg.learnerSeat,
      maxAreas: cfg.maxAreas,
      maxTurns: cfg.maxTurns,
      seedBase: cfg.seedBase,
      episodes: cfg.episodes,
      prngSeed: mixSeed(cfg.seedBase, 0),
      maxEdgesCap: MAX_EDGES_CAP,
    });
    wallMs = performance.now() - t0;
    merged = mergeShards([shard]);
  } else {
    const sizes = splitEpisodes(cfg.episodes, cfg.workers);
    let offset = 0;
    const t0 = performance.now();
    const promises = sizes.map((size, w) => {
      const seedBase = cfg.seedBase + offset;
      offset += size;
      if (size === 0) return Promise.resolve(emptyShard());
      return runWorker({
        seatNames,
        learner: cfg.learner,
        learnerSeat: cfg.learnerSeat,
        maxAreas: cfg.maxAreas,
        maxTurns: cfg.maxTurns,
        seedBase,
        episodes: size,
        prngSeed: mixSeed(cfg.seedBase, w + 1),
        maxEdgesCap: MAX_EDGES_CAP,
      });
    });
    const shards = await Promise.all(promises);
    wallMs = performance.now() - t0;
    merged = mergeShards(shards);
  }

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
    label: opponentsStr,
    playerCount,
    wallSec,
    stepsPerSec: merged.learnerDecisions / wallSec,
    gamesPerSec: merged.episodesRun / wallSec,
    decisionsPerGame: merged.learnerDecisions / merged.episodesRun,
    turnsPerGame: merged.totalTurns / merged.episodesRun,
    learnerWinPct: (100 * merged.wins) / merged.episodesRun,
    learnerElimPct: (100 * merged.eliminations) / merged.episodesRun,
    episodesRun: merged.episodesRun,
    learnerDecisions: merged.learnerDecisions,
    edge,
    overflow: merged.overflow,
    recMaxEdges: recommendMaxEdges(edge[100]),
    botBreakdown,
  };
}

// --- reporting ---

const fmtInt = n => Math.round(n).toLocaleString('en-US');
const fmtM = n => `${(n / 1e6).toFixed(2)}M`;

function reportLeague(name, r, cfg) {
  console.log(`\n── ${name} ──  [${r.label}, ${r.playerCount}-FFA]`);
  console.log(
    `  throughput:   ${fmtInt(r.stepsPerSec)} learner-steps/s  ·  ${r.gamesPerSec.toFixed(1)} games/s` +
      `  (${cfg.workers} worker${cfg.workers === 1 ? '' : 's'}, ${r.episodesRun} games, ${r.wallSec.toFixed(1)}s)`
  );
  console.log(
    `  per episode:  ${r.decisionsPerGame.toFixed(1)} learner decisions  ·  ${r.turnsPerGame.toFixed(1)} turns to terminal` +
      `  ·  learner win ${r.learnerWinPct.toFixed(1)}% / eliminated ${r.learnerElimPct.toFixed(1)}% (${cfg.learner} stub)`
  );
  const o = r.overflow ? `  ⚠ ${r.overflow} decisions ≥ ${MAX_EDGES_CAP} (p100 is a floor)` : '';
  console.log(
    `  numEdges:     p50 ${r.edge[50]} · p90 ${r.edge[90]} · p99 ${r.edge[99]} · p100 ${r.edge[100]} · ` +
      `mean ${r.edge.mean.toFixed(1)}  →  MAX_EDGES ${r.recMaxEdges}${o}`
  );
  const top = r.botBreakdown
    .map(b => `${b.base} ${b.avgMs.toFixed(3)}ms`)
    .slice(0, 5)
    .join(' · ');
  console.log(`  per-move avg: ${top}`);
}

function reportProjection(budget, cfg) {
  console.log(`\n── projection & go/no-go (budget league: ${budget.label}) ──`);
  const perCore = budget.stepsPerSec / Math.max(1, cfg.workers);
  console.log(
    `  this machine: ${fmtInt(budget.stepsPerSec)} steps/s aggregate over ${cfg.workers} worker(s)` +
      `  ·  ~${fmtInt(perCore)} steps/s/core  (${os.cpus().length} cores present)`
  );
  const hours = [6, 12, 24, 48];
  const proj = hours.map(h => `${h}h ${fmtM(budget.stepsPerSec * h * 3600)}`).join(' · ');
  console.log(`  env-steps @ this machine's aggregate rate:  ${proj}`);
  console.log(`  shodan estimate:  ~${fmtInt(perCore)} steps/s/core × (shodan cores)`);

  const steps12h = budget.stepsPerSec * 12 * 3600;
  let verdict;
  if (steps12h >= 2e6)
    verdict = `GREEN — a ~12h unit yields ${fmtM(steps12h)} env-steps (≳1–2M); build steps 4–7.`;
  else if (steps12h >= 5e5)
    verdict = `YELLOW — ~12h yields ${fmtM(steps12h)} env-steps (< 1–2M). Mitigate: fewer Lookahead seats / more cheap snapshots, or more cores; re-probe.`;
  else
    verdict = `RED — ~12h yields only ${fmtM(steps12h)} env-steps. In-process opponent cost may be prohibitive; rethink before Python.`;
  console.log(`  FAIL-FAST (~12h first unit):  ${verdict}`);
  console.log(
    `  NOTE: local number — re-run on shodan (training CPU + real core count) before locking the budget.`
  );
  return { steps12h, verdict, perCore };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = {
    learner: opts.learner ?? 'random',
    episodes: opts.episodes !== undefined ? Number(opts.episodes) : 300,
    workers: opts.workers !== undefined ? Number(opts.workers) : 1,
    seedBase: opts['seed-base'] !== undefined ? Number(opts['seed-base']) : 1,
    learnerSeat: opts['learner-seat'] !== undefined ? Number(opts['learner-seat']) : 0,
    maxTurns: opts['max-turns'] !== undefined ? Number(opts['max-turns']) : 500,
    maxAreas:
      opts['max-areas'] !== undefined ? Number(opts['max-areas']) : BC_POLICY.config.maxAreas,
  };
  if (cfg.learner !== 'random' && cfg.learner !== 'stop') {
    throw new Error(`--learner must be random|stop, got "${cfg.learner}".`);
  }

  const leagues = opts.opponents
    ? [{ key: 'custom', label: 'custom', opponents: opts.opponents }]
    : NAMED_LEAGUES;

  if (!opts.json) {
    console.log(
      `PPO throughput probe · learner=${cfg.learner} · episodes=${cfg.episodes} · ` +
        `workers=${cfg.workers} · maxAreas=${cfg.maxAreas} · maxTurns=${cfg.maxTurns}`
    );
  }

  const results = [];
  for (const league of leagues) {
    const r = await runLeague(league.opponents, cfg);
    results.push({ ...league, ...r });
    if (!opts.json) reportLeague(league.label, r, cfg);
  }

  const budget = results.find(r => r.key === 'realistic') ?? results[results.length - 1];
  if (!opts.json) {
    const proj = reportProjection(budget, cfg);
    void proj;
  } else {
    const perCore = budget.stepsPerSec / Math.max(1, cfg.workers);
    console.log(
      JSON.stringify(
        {
          config: cfg,
          cores: os.cpus().length,
          leagues: results.map(r => ({
            key: r.key,
            opponents: r.opponents,
            playerCount: r.playerCount,
            stepsPerSec: r.stepsPerSec,
            gamesPerSec: r.gamesPerSec,
            decisionsPerGame: r.decisionsPerGame,
            learnerWinPct: r.learnerWinPct,
            numEdges: {
              p50: r.edge[50],
              p90: r.edge[90],
              p99: r.edge[99],
              p100: r.edge[100],
              mean: r.edge.mean,
            },
            recMaxEdges: r.recMaxEdges,
            overflow: r.overflow,
            botBreakdown: r.botBreakdown,
          })),
          budget: {
            league: budget.key,
            stepsPerSec: budget.stepsPerSec,
            perCoreStepsPerSec: perCore,
            steps12h: budget.stepsPerSec * 12 * 3600,
          },
        },
        null,
        2
      )
    );
  }
}

main().catch(err => {
  process.stderr.write(`[ppo-throughput-probe] fatal: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
