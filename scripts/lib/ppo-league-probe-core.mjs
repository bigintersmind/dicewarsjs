/**
 * PPO PFSP-league probe core (ml-bot Phase 3 — Task B, step B5).
 *
 * Pure, shared helpers for `scripts/ppo-league-probe.mjs` and its worker. Where the Phase-3 tracer
 * throughput probe ([D-19]/[D-20]) measured a FIXED heterogeneous field, B5 must re-probe the field
 * the PFSP run actually trains against: mostly **net-policy snapshot seats** (BC-forward cost
 * ~0.8 ms/move vs ~0.02–0.4 ms for the cheap heuristics — [D-20]) drawn through the **real**
 * `makeLeague` sampler. So this core drives the live league end-to-end —
 * `refresh()` → `draw(seed)` → `runSelfPlayEpisode` → `recordResult` → `stats()` — with **no change
 * to the merged B1–B4 league code**. It is the genuine "first live exercise of the sampler" ([D-23]).
 *
 * Two distinct decisive-rates are measured and must NEVER be conflated ([D-23] verify correction):
 *   - **learner-relative** (`terminateOnElimination:true`, the trainer's exact regime —
 *     `ppo-env-server.mjs`): a learner win OR a learner elimination is a decisive terminal; only the
 *     learner surviving to `maxTurns` is a truncation. This is `league.stats().decisiveRate`, the
 *     number throughput is measured under, and the number the env-step budget locks against.
 *   - **global / [D-15] turtle health** (`terminateOnElimination:false`, full game): `winner !== null`.
 *     A self-similar snapshot field can turtle to a stalemate even when the learner-relative rate looks
 *     fine, so this is the separate turtle alarm — measured, never used to size the budget.
 *
 * Snapshots are injected without the Python producer: `buildSnapshotManifest` writes a
 * `refresh()`-loadable `manifest.json` plus one tiny **re-export shim** per snapshot
 * (`export { BC_POLICY } from '<the real ppo/bc policy module>'`), so `refresh()` dynamic-imports each
 * shim and wraps the SAME underlying ~2 MB policy module via `makeBC` — identical forward cost, no
 * N×2 MB copies, and (with `poolCap ≥ pool size`) no eviction unlink.
 *
 * @module scripts/lib/ppo-league-probe-core
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ENCODING_VERSION,
  assertPolicyEncodingCompatible,
} from '../../src/arena/encodeObservation.js';
import { argmax, forward } from '../../src/ai/bcForward.js';
import { BC_POLICY as PPO_POLICY } from '../../src/ai/ppoPolicyWeights.js';
import { BC_POLICY as BC_POLICY_WEIGHTS } from '../../src/ai/bcPolicyWeights.js';

import { makeLeague } from './ppo-league.mjs';
import { runSelfPlayEpisode } from './ppo-env.mjs';
import {
  mulberry32,
  makeStubChooseAction,
  percentilesFromHist,
  recommendMaxEdges,
  splitEpisodes,
} from './ppo-probe-core.mjs';

/*
 * Re-export the probe-core helpers the entrypoint + tests share, so B5's tooling imports them from one
 * place (mirrors how `ppo-probe-core.mjs` re-exports `mulberry32`).
 */
export { mulberry32, percentilesFromHist, recommendMaxEdges, splitEpisodes };

/**
 * The two encodingVersion-2 policy modules usable as snapshot seats AND as the greedy learner.
 * Both export `BC_POLICY` (the export name is the BC contract; `ppoPolicyWeights.js` is the merged
 * task-A PPO policy, `teacher:"ppo-tracer"`). Same architecture ⇒ same ~0.8 ms forward cost; mixing
 * the two gives the win-rate book two genuinely distinct behaviors so PFSP weighting is exercised
 * non-trivially ([D-23] verify note — identical copies would yield a ~uniform book).
 */
const POLICIES = { ppo: PPO_POLICY, bc: BC_POLICY_WEIGHTS };

/** File URLs of the real policy modules, for the re-export shims (resolved off this module's path). */
const POLICY_URLS = {
  ppo: new URL('../../src/ai/ppoPolicyWeights.js', import.meta.url).href,
  bc: new URL('../../src/ai/bcPolicyWeights.js', import.meta.url).href,
};

/**
 * A greedy net-policy action selector — `argmax(forward(policy, encoded).logits)`. This is exactly
 * `ai_bc`'s decision rule (it returns the index into `encoded.moves`, which `decodeAction` maps to an
 * attack `{from,to}` or STOP). The throughput probe's stub only does `random`/`stop`; the
 * learner-relative decisive-rate needs a REAL greedy policy (a random learner just dies fast and skews
 * the rate), so B5 drives the learner with this.
 *
 * @param {{encodingVersion:number, config:{maxAreas:number}}} policy
 * @returns {(encoded:{moves:unknown[]}) => number}
 */
export function makePolicyChooseAction(policy) {
  assertPolicyEncodingCompatible(policy, 'makePolicyChooseAction');
  return encoded => argmax(forward(policy, encoded).logits);
}

/**
 * The drawn-field shape for a given reserve count R at a fixed `count` (= playerCount − 1), mirroring
 * the league's own `reserveCount = min(R, count, #distinctReserveBaselines)` and `pfspCount = count −
 * reserveCount` ([D-23]). Note R ≥ `reserveDistinct` all collapse to the same field (reserve is capped
 * at the distinct non-`ai_bc` baselines), which the R-sweep report must flag.
 *
 * @param {number} R
 * @param {number} count
 * @param {number} reserveDistinct - distinct non-`ai_bc` baseline ids available
 * @returns {{reserveCount:number, pfspCount:number}}
 */
export function fieldShape(R, count, reserveDistinct) {
  const reserveCount = Math.min(R, count, reserveDistinct);
  return { reserveCount, pfspCount: count - reserveCount };
}

/**
 * The number of DISTINCT reserve baselines a `--opponents` CSV yields — distinct ids minus `ai_bc`
 * (the STOP/turtle lineage the league excludes). Mirrors `ppo-league.mjs`'s `reserveBaselinePool`
 * derivation so the R-sweep report can show where R caps out (R ≥ this all collapse to one field).
 *
 * @param {string} baselineCsv
 * @returns {number}
 */
export function reserveDistinctCount(baselineCsv) {
  return [
    ...new Set(
      baselineCsv
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    ),
  ].filter(id => id !== 'ai_bc').length;
}

/**
 * Parse a `--snapshot-mix` spec into per-source counts, then materialize ascending-step snapshot specs
 * that seed a pool with both policy behaviors. Forms:
 *   - `"ppo4,bc4"` → 4 ppo + 4 bc (explicit counts; `poolSize` ignored).
 *   - `"ppo,bc"`   → split `poolSize` as evenly as possible across the listed sources.
 *   - omitted      → even ppo/bc split across `poolSize`.
 *
 * @param {{poolSize:number, mix?:string}} opts
 * @returns {{id:string, step:number, source:'ppo'|'bc'}[]}
 */
export function buildProxySpecs({ poolSize, mix }) {
  const tokens = (mix ?? 'ppo,bc')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) throw new Error('buildProxySpecs: empty --snapshot-mix.');

  const counts = [];
  let hasExplicit = false;
  for (const tok of tokens) {
    const m = /^(ppo|bc)(\d+)?$/.exec(tok);
    if (!m) throw new Error(`buildProxySpecs: bad mix token "${tok}" (expected ppo[N] | bc[N]).`);
    const source = m[1];
    const n = m[2] === undefined ? null : Number(m[2]);
    if (n !== null) hasExplicit = true;
    counts.push({ source, n });
  }

  if (hasExplicit && counts.some(c => c.n === null)) {
    throw new Error(
      'buildProxySpecs: mix tokens must be all-counted (ppo4,bc4) or all-bare (ppo,bc).'
    );
  }

  let resolved;
  if (hasExplicit) {
    resolved = counts.map(c => ({ source: c.source, n: c.n }));
  } else {
    // Even split of poolSize across the bare sources; the remainder lands on the earliest sources.
    if (!Number.isInteger(poolSize) || poolSize <= 0) {
      throw new Error(`buildProxySpecs: poolSize must be a positive integer, got ${poolSize}.`);
    }
    const base = Math.floor(poolSize / counts.length);
    let rem = poolSize % counts.length;
    resolved = counts.map(c => ({ source: c.source, n: base + (rem-- > 0 ? 1 : 0) }));
  }

  const specs = [];
  let step = 0;
  for (const { source, n } of resolved) {
    for (let i = 0; i < n; i++) {
      step += 1; // ascending, distinct → deterministic FIFO order in refresh()
      specs.push({ id: `${source}-${step}`, step: step * 100, source });
    }
  }
  if (specs.length === 0) throw new Error('buildProxySpecs: resolved to zero snapshots.');
  return specs;
}

/**
 * Write a `refresh()`-loadable snapshot manifest + one re-export shim per spec into `dir`. The shim
 * re-exports `BC_POLICY` from the real policy module (file URL), so `league.refresh()` imports the shim
 * and `makeBC`-wraps the underlying ~2 MB module — no per-snapshot copy. Manifest schema matches the
 * producer's: `{encodingVersion, snapshots:[{id,step,weights,createdAt}], latestStep}`.
 *
 * @param {string} dir - scratch directory (created if absent)
 * @param {{specs:{id:string, step:number, source:'ppo'|'bc'}[], createdAt?:number}} opts
 * @returns {string} absolute path to the written manifest.json
 */
export function buildSnapshotManifest(dir, { specs, createdAt = 0 }) {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('buildSnapshotManifest: specs must be a non-empty array.');
  }
  mkdirSync(dir, { recursive: true });
  const snapshots = specs.map(spec => {
    const url = POLICY_URLS[spec.source];
    if (!url) {
      throw new Error(`buildSnapshotManifest: unknown snapshot source "${spec.source}" (ppo|bc).`);
    }
    const weightsFile = `snap-${spec.id}.weights.js`;
    writeFileSync(
      join(dir, weightsFile),
      `// B5 probe re-export shim — points league.refresh() at the real ${spec.source} policy module.\n` +
        `export { BC_POLICY } from '${url}';\n`
    );
    return { id: spec.id, step: spec.step, weights: weightsFile, createdAt };
  });
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        encodingVersion: ENCODING_VERSION,
        snapshots,
        latestStep: Math.max(...specs.map(s => s.step)),
      },
      null,
      2
    )
  );
  return manifestPath;
}

/**
 * Run one shard of the league probe: build a real `makeLeague`, load the snapshot pool via
 * `refresh()`, then for each episode `draw(seed)` the field, run it through `runSelfPlayEpisode`, and
 * (PASS A only) feed the result to `recordResult` so `league.stats()` accumulates the learner-relative
 * decisive-rate. Per-bot timing is keyed by `drawn[i].kind` so the report can show a single aggregate
 * "snapshot" per-move cost vs each baseline.
 *
 * @param {Object} cfg
 * @param {string} cfg.manifestPath - snapshot manifest to load into the league
 * @param {Object} cfg.leagueOpts - `makeLeague` opts EXCEPT `snapshotManifest`/`learnerSeat`
 *   (baselineCsv, count, poolCap, reserveBaselines, pfspEpsilon, pfspK)
 * @param {'random'|'stop'|'policy'} cfg.learner
 * @param {'ppo'|'bc'} [cfg.learnerPolicySource='ppo'] - which policy the `policy` learner uses
 * @param {number} cfg.learnerSeat
 * @param {number} cfg.maxAreas
 * @param {number} cfg.maxTurns
 * @param {number} cfg.seedBase
 * @param {number} cfg.episodes
 * @param {number} cfg.prngSeed - seed for the random-learner stub
 * @param {number} cfg.maxEdgesCap
 * @param {boolean} cfg.terminateOnElimination - true = PASS A (learner-relative); false = PASS B (global)
 * @param {boolean} cfg.record - feed results to `recordResult` (PASS A) — false keeps the book clean (PASS B)
 * @param {number} [cfg.expectedSnapshots] - if set, `refresh()` must load EXACTLY this many snapshots
 *   AND keep them all live (`loadedSnapshots === poolSize === expectedSnapshots`) or the shard throws;
 *   guards against silently measuring the cheap baseline field (0 loaded) or an eviction-shrunk pool
 *   (`poolCap < poolSize`). Omit to skip the check.
 * @returns {Promise<Object>} shard accumulation incl. `leagueStats`
 */
export async function runLeagueProbeShard({
  manifestPath,
  leagueOpts,
  learner,
  learnerPolicySource = 'ppo',
  learnerSeat,
  maxAreas,
  maxTurns,
  seedBase,
  episodes,
  prngSeed,
  maxEdgesCap,
  terminateOnElimination,
  record,
  expectedSnapshots,
}) {
  const league = makeLeague({ ...leagueOpts, snapshotManifest: manifestPath, learnerSeat });
  await league.refresh(); // load the snapshot pool once — the manifest is static for the probe

  /*
   * Guard the one invariant every B5 number depends on: the snapshot pool actually loaded AND is fully
   * sampleable. Two distinct ways `draw()` could silently sample the wrong field:
   *   - 0 loaded → `draw()` falls through to the cycled BASELINE field, a completely different
   *     (cheap-heuristic) regime (`stats().loadedSnapshots`).
   *   - `poolCap < poolSize` → `refresh()` loads every snapshot (so `loadedSnapshots` still matches —
   *     it counts every id EVER imported) but FIFO-evicts the live `pool` down to `poolCap`, so `draw()`
   *     samples a SMALLER, skewed field than requested (`stats().poolSize`, the live sampleable set).
   * Either would lock a wrong budget with nothing failing loud, so assert BOTH equal the expected count
   * (the CLI also rejects `poolCap < poolSize` up front via `assertPoolCapFitsPool`; this is the
   * defense-in-depth at the measurement seam, and the only guard when `runLeagueProbeShard` is driven
   * directly with a custom `leagueOpts.poolCap`).
   */
  if (expectedSnapshots !== undefined) {
    const { loadedSnapshots, poolSize } = league.stats();
    if (loadedSnapshots !== expectedSnapshots || poolSize !== expectedSnapshots) {
      throw new Error(
        `runLeagueProbeShard: refresh() loaded ${loadedSnapshots} snapshots (live pool ${poolSize}), ` +
          `expected ${expectedSnapshots} (manifest ${manifestPath}). The probe would silently measure ` +
          `the wrong field (baseline fallback if 0 loaded, or an eviction-shrunk pool if poolCap < ` +
          `poolSize) — aborting so a wrong budget is never locked.`
      );
    }
  }

  const chooseAction =
    learner === 'policy'
      ? makePolicyChooseAction(POLICIES[learnerPolicySource] ?? PPO_POLICY)
      : makeStubChooseAction(learner, mulberry32(prngSeed));

  const hist = new Array(maxEdgesCap).fill(0);
  let overflow = 0;
  let learnerDecisions = 0;
  const onObservation = encoded => {
    const n = encoded.moves.length;
    learnerDecisions++;
    if (n < hist.length) hist[n] += 1;
    else overflow += 1;
  };

  const botMs = new Map();
  const botCalls = new Map();
  let totalTurns = 0;
  let wins = 0;
  let eliminations = 0;
  let globalDecisive = 0; // winner !== null — meaningful only under terminateOnElimination:false (PASS B)
  let episodesRun = 0;

  const t0 = performance.now();
  for (let e = 0; e < episodes; e++) {
    const seed = seedBase + e;
    const { opponents, drawn } = league.draw(seed);

    // Time each opponent's move, bucketed by kind so the report aggregates all snapshot seats together.
    const timed = opponents.map((o, i) => {
      const base = drawn[i].kind === 'snapshot' ? 'snapshot' : o.name.replace(/@\d+$/, '');
      return {
        name: o.name,
        fn: botState => {
          const ts = performance.now();
          try {
            return o.fn(botState);
          } finally {
            botMs.set(base, (botMs.get(base) || 0) + (performance.now() - ts));
            botCalls.set(base, (botCalls.get(base) || 0) + 1);
          }
        },
      };
    });

    const res = runSelfPlayEpisode({
      seed,
      opponents: timed,
      learnerSeat,
      maxAreas,
      maxTurns,
      chooseAction,
      onObservation,
      terminateOnElimination,
    });
    totalTurns += res.turnCount;
    wins += res.won;
    if (res.eliminated) eliminations += 1;
    if (res.winner !== null) globalDecisive += 1;
    if (record) league.recordResult(drawn, res);
    episodesRun += 1;
  }
  const elapsedMs = performance.now() - t0;

  return {
    elapsedMs,
    episodesRun,
    totalTurns,
    learnerDecisions,
    wins,
    eliminations,
    globalDecisive,
    hist,
    overflow,
    botMs: Object.fromEntries(botMs),
    botCalls: Object.fromEntries(botCalls),
    leagueStats: league.stats(),
  };
}

/**
 * Merge league-probe shards. Scalars/histograms/per-bot timing sum element-wise; the league
 * decisive-rate is a **ratio-of-sums** (each worker has its own cold book, so summing the counters and
 * recomputing the ratio is the only correct aggregate — [D-23] verify note). `elapsedMs` is NOT summed
 * (the caller times wall-clock around the concurrent shards).
 *
 * @param {Awaited<ReturnType<typeof runLeagueProbeShard>>[]} shards
 */
export function mergeLeagueShards(shards) {
  const hist = [];
  const botMs = {};
  const botCalls = {};
  let learnerDecisions = 0;
  let totalTurns = 0;
  let episodesRun = 0;
  let wins = 0;
  let eliminations = 0;
  let globalDecisive = 0;
  let overflow = 0;
  let decisiveGames = 0;
  let truncatedGames = 0;
  let noSeatBeatGames = 0;
  let poolSize = 0;
  let loadedSnapshots = 0;
  let bookSize = 0;
  for (const s of shards) {
    learnerDecisions += s.learnerDecisions;
    totalTurns += s.totalTurns;
    episodesRun += s.episodesRun;
    wins += s.wins;
    eliminations += s.eliminations;
    globalDecisive += s.globalDecisive;
    overflow += s.overflow;
    for (let k = 0; k < s.hist.length; k++) hist[k] = (hist[k] || 0) + s.hist[k];
    for (const [b, v] of Object.entries(s.botMs)) botMs[b] = (botMs[b] || 0) + v;
    for (const [b, v] of Object.entries(s.botCalls)) botCalls[b] = (botCalls[b] || 0) + v;
    const ls = s.leagueStats;
    decisiveGames += ls.decisiveGames;
    truncatedGames += ls.truncatedGames;
    noSeatBeatGames += ls.noSeatBeatGames;
    poolSize = Math.max(poolSize, ls.poolSize); // identical across shards (same manifest)
    loadedSnapshots = Math.max(loadedSnapshots, ls.loadedSnapshots);
    bookSize += ls.bookSize; // per-worker books; sum is informational
  }
  const total = decisiveGames + truncatedGames;
  return {
    hist,
    learnerDecisions,
    totalTurns,
    episodesRun,
    wins,
    eliminations,
    globalDecisive,
    overflow,
    botMs,
    botCalls,
    leagueStats: {
      poolSize,
      loadedSnapshots,
      bookSize,
      decisiveGames,
      truncatedGames,
      decisiveRate: total > 0 ? decisiveGames / total : 0,
      noSeatBeatGames,
    },
  };
}

/**
 * The seconds to divide aggregate learner-decisions by for the steady-state throughput rate. Uses the
 * MAX of the per-shard steady-state loop times (`elapsedMs`) — NOT their sum, and NOT the parent wall
 * clock: the shards run CONCURRENTLY, so the steady-state wall ≈ the slowest shard's loop, and each
 * shard's `elapsedMs` is already timed around its episode loop only (it excludes Worker spawn + the
 * cold ~4 MB policy re-parse + `refresh()`, which the long-lived training env-server amortizes to ~0).
 * Zero-elapsed shards (the `workers > episodes` empty-shard path) are filtered out; if EVERY shard is
 * zero (degenerate, e.g. `episodes = 0`) it falls back to `wallMs`, which BOUNDS the steady-state rate
 * from above — so the fallback can only DOWNGRADE a verdict, never falsely upgrade one to GREEN.
 *
 * This is the [B5 review must-fix] made testable: summing instead of MAXing, or using the wall incl.
 * cold start, deflated stepsPerSec ~15–35% at shodan scale and could falsely downgrade a GREEN budget.
 *
 * @param {{elapsedMs:number}[]} shards - per-shard accumulations (each carries its steady-state `elapsedMs`)
 * @param {number} wallMs - parent wall-clock around the concurrent shards (the all-zero fallback)
 * @returns {number} seconds to use as the throughput denominator
 */
export function steadyStateSec(shards, wallMs) {
  const steadyMs = Math.max(0, ...shards.map(s => s.elapsedMs).filter(ms => ms > 0));
  return (steadyMs > 0 ? steadyMs : wallMs) / 1000;
}

/**
 * The fail-fast env-step budget projection, replicating the throughput probe's thresholds
 * (`ppo-throughput-probe.mjs`): a ~12h first unit yields GREEN ≥ 2M env-steps, YELLOW ≥ 0.5M, else RED.
 *
 * @param {number} stepsPerSec - aggregate learner-steps/sec
 * @returns {{steps12h:number, verdict:'GREEN'|'YELLOW'|'RED'}}
 */
export function projectBudget(stepsPerSec) {
  const steps12h = stepsPerSec * 12 * 3600;
  let verdict;
  if (steps12h >= 2e6) verdict = 'GREEN';
  else if (steps12h >= 5e5) verdict = 'YELLOW';
  else verdict = 'RED';
  return { steps12h, verdict };
}
