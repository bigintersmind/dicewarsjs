/**
 * PPO throughput + action-space probe core (ml-bot Phase 3 — [D-19], tracer step 3).
 *
 * Pure, shared helpers for `scripts/ppo-throughput-probe.mjs` and its worker. The probe
 * answers the two existential Phase-3 questions before any Python/PPO work:
 *   1. **Throughput** — learner-steps/sec the machine can simulate (the [D-19] bottleneck is
 *      the in-process opponents, NOT the wire; reachability of the env-step budget is UNPROVEN
 *      until measured against the real `ai_lookahead` league).
 *   2. **`MAX_EDGES`** — the per-decision action-count (`numEdges = #legal attacks + STOP`)
 *      distribution, to size the fixed action-space pad for MaskablePPO (estimate ~64–128,
 *      well under sb3-contrib #247's ~1400 sparse-mask crash zone; p100 never yet measured).
 *
 * No socket: the shard driver calls the env core (`runSelfPlayEpisode`) directly with a
 * synchronous stub `chooseAction`, isolating the dominant opponent-simulation cost. The wire
 * is ~2–10% on top ([D-19]) and not the gating number.
 *
 * @module scripts/lib/ppo-probe-core
 */

import { mulberry32 } from './mulberry32.mjs';
import { runSelfPlayEpisode } from './ppo-env.mjs';

/*
 * `mulberry32` (the `random` learner's reproducible PRNG) moved to its own dependency-free module so
 * the PFSP league can borrow it without importing this benchmark tool. Re-exported here so existing
 * consumers (and the throughput-probe test) keep importing it from `ppo-probe-core.mjs` unchanged.
 */
export { mulberry32 };

/**
 * Build a synchronous stub action selector for the learner seat.
 *   - `random`: uniform over the legal index space (a real policy's mix of attacks + STOP).
 *   - `stop`: always the trailing STOP index — a conservative throughput floor (fewest
 *     learner decisions per turn ⇒ the most opponent simulation amortized into each step).
 *
 * @param {'random'|'stop'} mode
 * @param {() => number} prng - a [0,1) source (used by `random`)
 * @returns {(encoded:{moves:unknown[]}) => number}
 */
export function makeStubChooseAction(mode, prng) {
  if (mode === 'stop') {
    return encoded => encoded.moves.length - 1;
  }
  if (mode === 'random') {
    return encoded => {
      const n = encoded.moves.length;
      return Math.min(n - 1, Math.floor(prng() * n));
    };
  }
  throw new Error(`makeStubChooseAction: unknown learner mode "${mode}" (expected random|stop).`);
}

/**
 * Percentiles + max + mean from an action-count histogram (`hist[k]` = #decisions whose
 * `numEdges === k`). Nearest-rank percentiles: the p-th value is the smallest `k` whose
 * cumulative count reaches `ceil(p/100 · total)`.
 *
 * @param {number[]} hist - count indexed by numEdges value
 * @param {number[]} ps - percentile points (e.g. [50, 90, 99, 100])
 * @returns {{[p:number]: number, max: number, mean: number, total: number}}
 */
export function percentilesFromHist(hist, ps) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) {
    const empty = { max: 0, mean: 0, total: 0 };
    for (const p of ps) empty[p] = 0;
    return empty;
  }
  let weighted = 0;
  let maxVal = 0;
  for (let k = 0; k < hist.length; k++) {
    if (hist[k] > 0) {
      weighted += k * hist[k];
      maxVal = k;
    }
  }
  const sortedPs = [...ps].sort((a, b) => a - b);
  const out = { max: maxVal, mean: weighted / total, total };
  let cum = 0;
  let pi = 0;
  for (let k = 0; k < hist.length && pi < sortedPs.length; k++) {
    cum += hist[k];
    while (pi < sortedPs.length && cum >= Math.ceil((sortedPs[pi] / 100) * total)) {
      out[sortedPs[pi]] = k;
      pi++;
    }
  }
  while (pi < sortedPs.length) out[sortedPs[pi++]] = maxVal;
  return out;
}

/**
 * Recommend `MAX_EDGES` = the next power of two ≥ the observed p100 (min 8). A power of two
 * keeps the padded action head friendly; the p100 keeps it tight (well under #247's ~1400).
 *
 * @param {number} p100
 * @returns {number}
 */
export function recommendMaxEdges(p100) {
  let m = 8;
  while (m < p100) m *= 2;
  return m;
}

/**
 * Run one shard of episodes with a stub learner vs the given opponent seats, accumulating
 * throughput, the numEdges histogram, and per-bot timing. Called both single-threaded (main)
 * and inside each `--workers` worker.
 *
 * @param {Object} cfg
 * @param {Array<{name:string, fn:Function}>} cfg.seats - opponent seats (length playerCount-1)
 * @param {'random'|'stop'} cfg.learner
 * @param {number} cfg.learnerSeat
 * @param {number} cfg.maxAreas
 * @param {number} cfg.maxTurns
 * @param {number} cfg.seedBase - engine seed of this shard's first episode
 * @param {number} cfg.episodes - episode count for this shard
 * @param {number} cfg.prngSeed - seed for the random-learner PRNG
 * @param {number} cfg.maxEdgesCap - histogram width; numEdges ≥ this counts as overflow
 * @returns {{elapsedMs:number, episodesRun:number, totalTurns:number, learnerDecisions:number,
 *   wins:number, hist:number[], overflow:number, botMs:Object, botCalls:Object}}
 */
export function runProbeShard({
  seats,
  learner,
  learnerSeat,
  maxAreas,
  maxTurns,
  seedBase,
  episodes,
  prngSeed,
  maxEdgesCap,
}) {
  const botMs = new Map();
  const botCalls = new Map();
  const timedSeats = seats.map(seat => {
    const base = seat.name.replace(/#\d+$/, '');
    return {
      name: seat.name,
      fn: botState => {
        const t0 = performance.now();
        try {
          return seat.fn(botState);
        } finally {
          botMs.set(base, (botMs.get(base) || 0) + (performance.now() - t0));
          botCalls.set(base, (botCalls.get(base) || 0) + 1);
        }
      },
    };
  });

  const prng = mulberry32(prngSeed);
  const chooseAction = makeStubChooseAction(learner, prng);
  const hist = new Array(maxEdgesCap).fill(0);
  let overflow = 0;
  let learnerDecisions = 0;
  const onObservation = encoded => {
    const n = encoded.moves.length;
    learnerDecisions++;
    if (n < hist.length) hist[n] += 1;
    else overflow += 1;
  };

  let totalTurns = 0;
  let wins = 0;
  let eliminations = 0;
  let episodesRun = 0;
  const t0 = performance.now();
  for (let e = 0; e < episodes; e++) {
    /*
     * PPO terminal: stop at the learner's elimination (no opponent-only tail) — the env core's
     * canonical early termination. The numEdges histogram is unaffected (every learner decision
     * happens before its elimination); only the simulated wall-clock shrinks.
     */
    const res = runSelfPlayEpisode({
      seed: seedBase + e,
      opponents: timedSeats,
      learnerSeat,
      maxAreas,
      maxTurns,
      chooseAction,
      onObservation,
      terminateOnElimination: true,
    });
    totalTurns += res.turnCount;
    wins += res.won;
    if (res.eliminated) eliminations += 1; // eliminated mid-game → a loss (wins += 0)
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
    hist,
    overflow,
    botMs: Object.fromEntries(botMs),
    botCalls: Object.fromEntries(botCalls),
  };
}

/**
 * Merge shard results (element-wise histogram sum, scalar sums, per-bot timing sums).
 * `elapsedMs` is intentionally NOT summed — wall-clock for a parallel run is measured by the
 * caller around the concurrent shards.
 *
 * @param {ReturnType<typeof runProbeShard>[]} shards
 */
export function mergeShards(shards) {
  const hist = [];
  let learnerDecisions = 0;
  let totalTurns = 0;
  let episodesRun = 0;
  let wins = 0;
  let eliminations = 0;
  let overflow = 0;
  const botMs = {};
  const botCalls = {};
  for (const s of shards) {
    learnerDecisions += s.learnerDecisions;
    totalTurns += s.totalTurns;
    episodesRun += s.episodesRun;
    wins += s.wins;
    eliminations += s.eliminations || 0;
    overflow += s.overflow;
    for (let k = 0; k < s.hist.length; k++) hist[k] = (hist[k] || 0) + s.hist[k];
    for (const [b, v] of Object.entries(s.botMs)) botMs[b] = (botMs[b] || 0) + v;
    for (const [b, v] of Object.entries(s.botCalls)) botCalls[b] = (botCalls[b] || 0) + v;
  }
  return {
    hist,
    learnerDecisions,
    totalTurns,
    episodesRun,
    wins,
    eliminations,
    overflow,
    botMs,
    botCalls,
  };
}

/**
 * Split `total` episodes into `n` contiguous chunks (sizes differ by ≤ 1). Each chunk maps to
 * a distinct engine-seed sub-range so shards never overlap.
 *
 * @param {number} total
 * @param {number} n
 * @returns {number[]} chunk sizes (length n; may include trailing zeros if n > total)
 */
export function splitEpisodes(total, n) {
  const base = Math.floor(total / n);
  let rem = total % n;
  return Array.from({ length: n }, () => base + (rem-- > 0 ? 1 : 0));
}
