/**
 * PPO PFSP-league probe pure helpers (ml-bot Phase 3 — Task B, step B5).
 *
 * Unit-tests the deterministic, pure pieces of the B5 league probe: the field-shape arithmetic, the
 * reserve-distinct count, the snapshot-spec/mix parser, the proxy-manifest builder (asserted by driving
 * a REAL `makeLeague(...).refresh()` against it), the greedy policy chooser, the shard merge
 * (ratio-of-sums), the budget projection, and the entrypoint arg parsers. The heavy measurement RUN
 * (`runLeagueProbeShard` / `runSelfPlayEpisode` over many episodes) is intentionally NOT exercised
 * here — it's a measurement script, run via `npm run ppo:league-probe`, kept out of the unit suite
 * (mirrors `ppo-throughput-probe.test.js`).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGame } from '../../src/engine/GameRunner.js';
import { getValidMoves } from '../../src/engine/StateManager.js';
import { createBotState } from '../../src/arena/botState.js';
import {
  ENCODING_VERSION,
  encodeObservationForInference,
} from '../../src/arena/encodeObservation.js';
import { argmax, forward } from '../../src/ai/bcForward.js';
import { BC_POLICY as PPO_POLICY } from '../../src/ai/ppoPolicyWeights.js';
import { BC_POLICY as BC_WEIGHTS } from '../../src/ai/bcPolicyWeights.js';

import { makeLeague } from '../../scripts/lib/ppo-league.mjs';
import {
  fieldShape,
  reserveDistinctCount,
  buildProxySpecs,
  buildSnapshotManifest,
  makePolicyChooseAction,
  mergeLeagueShards,
  steadyStateSec,
  projectBudget,
  runLeagueProbeShard,
} from '../../scripts/lib/ppo-league-probe-core.mjs';
import {
  parseArgs,
  numArg,
  parseRSweep,
  emptyLeagueShard,
  assertPoolCapFitsPool,
} from '../../scripts/ppo-league-probe.mjs';

const DEFAULT_OPPONENTS = 'ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive';

/*
 * The `runLeagueProbeShard` integration tests run real `runSelfPlayEpisode` games. Under CI coverage
 * instrumentation the engine is several-fold slower, so the default 5 s per-test timeout is too tight
 * (the same reason `ppo-env.test.js` raises it). 30 s is the backstop; the integration `baseCfg` below
 * also caps `maxTurns` to keep each synchronous episode block short. The pure-helper tests finish in ms,
 * so the raised ceiling never masks a real hang.
 */
vi.setConfig({ testTimeout: 30_000 });

describe('fieldShape', () => {
  it('matches the league reserveCount = min(R, count, reserveDistinct), pfspCount = count - reserveCount', () => {
    // count=6, reserveDistinct=4 (the default CSV) — the real B5 field.
    expect(fieldShape(0, 6, 4)).toEqual({ reserveCount: 0, pfspCount: 6 });
    expect(fieldShape(2, 6, 4)).toEqual({ reserveCount: 2, pfspCount: 4 });
    expect(fieldShape(3, 6, 4)).toEqual({ reserveCount: 3, pfspCount: 3 });
    // R >= reserveDistinct all collapse to the same field (reserve capped at the 4 distinct baselines).
    expect(fieldShape(4, 6, 4)).toEqual({ reserveCount: 4, pfspCount: 2 });
    expect(fieldShape(6, 6, 4)).toEqual({ reserveCount: 4, pfspCount: 2 });
  });
});

describe('reserveDistinctCount', () => {
  it('counts distinct ids minus ai_bc (mirrors the league reserve pool)', () => {
    expect(reserveDistinctCount(DEFAULT_OPPONENTS)).toBe(4); // 5 ids, ai_bc excluded
  });
  it('dedups and drops blanks', () => {
    expect(reserveDistinctCount('ai_lookahead, ai_lookahead , ,ai_strategist')).toBe(2);
  });
  it('is 0 for an ai_bc-only field (no reserve baselines → all seats PFSP)', () => {
    expect(reserveDistinctCount('ai_bc')).toBe(0);
  });
});

describe('buildProxySpecs', () => {
  it('honors explicit counts (ppo4,bc4 → 4 ppo + 4 bc, ascending distinct steps)', () => {
    const specs = buildProxySpecs({ poolSize: 99, mix: 'ppo4,bc4' });
    expect(specs).toHaveLength(8);
    expect(specs.filter(s => s.source === 'ppo')).toHaveLength(4);
    expect(specs.filter(s => s.source === 'bc')).toHaveLength(4);
    const steps = specs.map(s => s.step);
    expect(new Set(steps).size).toBe(8); // distinct
    expect([...steps]).toEqual([...steps].sort((a, b) => a - b)); // ascending
    expect(new Set(specs.map(s => s.id)).size).toBe(8); // distinct ids
  });
  it('splits poolSize across bare sources, remainder to the earliest', () => {
    const specs = buildProxySpecs({ poolSize: 5, mix: 'ppo,bc' });
    expect(specs.filter(s => s.source === 'ppo')).toHaveLength(3); // ceil
    expect(specs.filter(s => s.source === 'bc')).toHaveLength(2); // floor
  });
  it('defaults to an even ppo/bc split when mix is omitted', () => {
    const specs = buildProxySpecs({ poolSize: 8 });
    expect(specs.filter(s => s.source === 'ppo')).toHaveLength(4);
    expect(specs.filter(s => s.source === 'bc')).toHaveLength(4);
  });
  it('rejects a bad mix token and a mixed counted/bare spec', () => {
    expect(() => buildProxySpecs({ poolSize: 4, mix: 'ppo4,xyz' })).toThrow(/bad mix token/);
    expect(() => buildProxySpecs({ poolSize: 4, mix: 'ppo4,bc' })).toThrow(/all-counted .* all-bare/);
  });
});

describe('buildSnapshotManifest → real makeLeague.refresh()', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'b5-probe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a manifest a real league loads, one snapshot per spec', async () => {
    const specs = buildProxySpecs({ poolSize: 4, mix: 'ppo2,bc2' });
    const manifestPath = buildSnapshotManifest(dir, { specs });
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.encodingVersion).toBe(ENCODING_VERSION);
    expect(manifest.snapshots).toHaveLength(4);
    // Each entry references an on-disk shim file...
    for (const s of manifest.snapshots) expect(existsSync(join(dir, s.weights))).toBe(true);
    // ...and the shim points at the RIGHT policy module (a ppo↔bc swap or one-URL collapse would still
    // load and pass the count check, silently defeating the [D-23] distinct-behavior premise).
    for (const s of manifest.snapshots) {
      const shim = readFileSync(join(dir, s.weights), 'utf8');
      const want = s.id.startsWith('ppo') ? 'ppoPolicyWeights.js' : 'bcPolicyWeights.js';
      const other = s.id.startsWith('ppo') ? 'bcPolicyWeights.js' : 'ppoPolicyWeights.js';
      expect(shim).toContain(want);
      expect(shim).not.toContain(other);
    }

    const lg = makeLeague({
      baselineCsv: DEFAULT_OPPONENTS,
      count: 6,
      learnerSeat: 0,
      snapshotManifest: manifestPath,
    });
    expect(await lg.refresh()).toEqual({ added: 4, poolSize: 4 });
    expect(lg.stats()).toMatchObject({ poolSize: 4, loadedSnapshots: 4 });

    // The hot-loaded snapshot is a usable makeBC-wrapped bot: a drawn field seats 6 callable opponents.
    const { opponents } = lg.draw(123);
    expect(opponents).toHaveLength(6);
    for (const o of opponents) expect(typeof o.fn).toBe('function');
  });

  it('the real draw() seats exactly fieldShape(R, count, reserveDistinct) baseline/snapshot kinds', async () => {
    const specs = buildProxySpecs({ poolSize: 6, mix: 'ppo3,bc3' });
    const manifestPath = buildSnapshotManifest(dir, { specs });
    const count = 6;
    const reserveDistinct = reserveDistinctCount(DEFAULT_OPPONENTS); // 4
    for (const R of [2, 3, 4]) {
      // R=4 is the collapse case (capped at 4 distinct baselines → 2 PFSP seats).
      const lg = makeLeague({
        baselineCsv: DEFAULT_OPPONENTS,
        count,
        learnerSeat: 0,
        snapshotManifest: manifestPath,
        reserveBaselines: R,
      });
      await lg.refresh();
      const { drawn } = lg.draw(99);
      const shape = fieldShape(R, count, reserveDistinct);
      expect(drawn.filter(d => d.kind === 'baseline')).toHaveLength(shape.reserveCount);
      expect(drawn.filter(d => d.kind === 'snapshot')).toHaveLength(shape.pfspCount);
    }
  });

  it('throws on an unknown snapshot source', () => {
    expect(() => buildSnapshotManifest(dir, { specs: [{ id: 'x', step: 1, source: 'zzz' }] })).toThrow(
      /unknown snapshot source/
    );
  });
});

describe('runLeagueProbeShard — record/decisive semantics (small integration)', () => {
  let dir;
  let manifestPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'b5-shard-'));
    manifestPath = buildSnapshotManifest(dir, { specs: buildProxySpecs({ poolSize: 4, mix: 'ppo2,bc2' }) });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // manifestPath is supplied per-test (it is assigned in beforeEach, after this literal evaluates).
  const baseCfg = {
    leagueOpts: { baselineCsv: DEFAULT_OPPONENTS, count: 6, reserveBaselines: 3 },
    learner: 'policy',
    learnerSeat: 0,
    maxAreas: 32,
    // Short cap: the record/decisive invariants asserted here are turn-count-independent (a decisive
    // game stays wins+eliminations; the rest truncate), so a short cap keeps each synchronous episode
    // block fast under CI coverage without changing what the test proves.
    maxTurns: 60,
    seedBase: 1,
    episodes: 5,
    prngSeed: 7,
    maxEdgesCap: 1500,
    expectedSnapshots: 4,
  };

  it('PASS A (record:true, terminateOnElim:true) books every episode; decisive = wins + eliminations', async () => {
    const cfg = { ...baseCfg, manifestPath, terminateOnElimination: true, record: true };
    const s = await runLeagueProbeShard(cfg);
    expect(s.episodesRun).toBe(5);
    expect(s.leagueStats.decisiveGames + s.leagueStats.truncatedGames).toBe(5);
    // Under terminateOnElimination:true a learner WIN or ELIMINATION is the (only) decisive terminal.
    expect(s.leagueStats.decisiveGames).toBe(s.wins + s.eliminations);
    expect(s.leagueStats.noSeatBeatGames).toBe(0);
    expect(s.leagueStats.loadedSnapshots).toBe(4);
  });

  it('PASS B (record:false) keeps the book clean so the turtle pass never pollutes PFSP', async () => {
    const cfg = { ...baseCfg, manifestPath, terminateOnElimination: false, record: false };
    const s = await runLeagueProbeShard(cfg);
    expect(s.episodesRun).toBe(5);
    expect(s.leagueStats.decisiveGames).toBe(0);
    expect(s.leagueStats.truncatedGames).toBe(0);
    expect(s.leagueStats.bookSize).toBe(0);
  });

  it('throws loudly if the pool fails to load the expected snapshot count', async () => {
    const cfg = { ...baseCfg, manifestPath, terminateOnElimination: true, record: true, expectedSnapshots: 99 };
    await expect(runLeagueProbeShard(cfg)).rejects.toThrow(
      /loaded 4 snapshots \(live pool 4\), expected 99/
    );
  });

  it('throws if poolCap evicts the live pool below the expected count (loaded ok, sampleable shrunk)', async () => {
    // poolCap=2 < 4 snapshots → refresh() loads all 4 (loadedSnapshots stays 4) but FIFO-evicts the
    // live pool to 2, so draw() would sample a smaller/skewed field. The strengthened guard catches it.
    const cfg = {
      ...baseCfg,
      manifestPath,
      leagueOpts: { ...baseCfg.leagueOpts, poolCap: 2 },
      terminateOnElimination: true,
      record: true,
      expectedSnapshots: 4,
    };
    await expect(runLeagueProbeShard(cfg)).rejects.toThrow(
      /loaded 4 snapshots \(live pool 2\), expected 4/
    );
  });
});

describe('makePolicyChooseAction', () => {
  /** First seed whose acting seat has at least one legal attack (mirrors ppo-action-parity). */
  function realEncoded(maxAreas) {
    for (let seed = 1; seed <= 600; seed++) {
      const state = createGame({ seed, playerCount: 7, recordHistory: false });
      const moves = getValidMoves(state);
      if (moves.length >= 1) {
        const active = state.turnOrder[state.currentPlayerIndex];
        const botState = createBotState(state, active);
        return encodeObservationForInference(botState, { maxAreas });
      }
    }
    throw new Error('no state with a legal attack in seeds 1..600');
  }

  it('returns exactly argmax(forward(policy).logits), in range, for a real observation (ppo and bc)', () => {
    for (const policy of [PPO_POLICY, BC_WEIGHTS]) {
      const enc = realEncoded(policy.config.maxAreas);
      const idx = makePolicyChooseAction(policy)(enc);
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(enc.moves.length);
      // It must BE ai_bc's decision rule, not merely an in-range index (a constant 0 would pass that).
      expect(idx).toBe(argmax(forward(policy, enc).logits));
    }
  });

  it('fails loud on an encodingVersion mismatch', () => {
    expect(() => makePolicyChooseAction({ encodingVersion: 999, config: { maxAreas: 32 } })).toThrow(
      /encodingVersion/
    );
  });
});

describe('mergeLeagueShards', () => {
  // Two DELIBERATELY ASYMMETRIC shards: unequal decisive totals (10 vs 90) so ratio-of-sums diverges
  // from the naive average of per-shard rates, and differing poolSize/loadedSnapshots so a MAX-vs-SUM
  // regression is caught.
  const a = {
    elapsedMs: 5,
    episodesRun: 10,
    totalTurns: 100,
    learnerDecisions: 50,
    wins: 1,
    eliminations: 9,
    globalDecisive: 3,
    hist: [0, 0, 3, 2],
    overflow: 1,
    botMs: { snapshot: 80, 'AI Lookahead': 20 },
    botCalls: { snapshot: 100, 'AI Lookahead': 40 },
    leagueStats: {
      poolSize: 8,
      loadedSnapshots: 8,
      bookSize: 5,
      noSeatBeatGames: 0,
      decisiveGames: 1, // total 10 → rate 0.10
      truncatedGames: 9,
      decisiveRate: 0.1,
    },
  };
  const b = {
    elapsedMs: 7,
    episodesRun: 90,
    totalTurns: 900,
    learnerDecisions: 450,
    wins: 20,
    eliminations: 70,
    globalDecisive: 60,
    hist: [0, 1, 4, 0, 5],
    overflow: 2,
    botMs: { snapshot: 700, Strategist: 30 },
    botCalls: { snapshot: 900, Strategist: 50 },
    leagueStats: {
      poolSize: 6, // differs from a → exercises MAX
      loadedSnapshots: 6,
      bookSize: 7,
      noSeatBeatGames: 3,
      decisiveGames: 80, // total 90 → rate 0.888…
      truncatedGames: 10,
      decisiveRate: 80 / 90,
    },
  };

  it('sums scalars/histograms/timing, MAXes pool sizes, and SUMs book size', () => {
    const m = mergeLeagueShards([a, b]);
    expect(m.learnerDecisions).toBe(500);
    expect(m.episodesRun).toBe(100);
    expect(m.totalTurns).toBe(1000);
    expect(m.wins).toBe(21);
    expect(m.eliminations).toBe(79);
    expect(m.globalDecisive).toBe(63);
    expect(m.overflow).toBe(3);
    expect(m.hist).toEqual([0, 1, 7, 2, 5]); // element-wise sum across differing lengths
    expect(m.botMs).toEqual({ snapshot: 780, 'AI Lookahead': 20, Strategist: 30 });
    expect(m.botCalls).toEqual({ snapshot: 1000, 'AI Lookahead': 40, Strategist: 50 });
    expect(m.leagueStats.decisiveGames).toBe(81);
    expect(m.leagueStats.truncatedGames).toBe(19);
    expect(m.leagueStats.noSeatBeatGames).toBe(3);
    expect(m.leagueStats.poolSize).toBe(8); // MAX(8, 6), not 14
    expect(m.leagueStats.loadedSnapshots).toBe(8); // MAX(8, 6)
    expect(m.leagueStats.bookSize).toBe(12); // per-worker books SUMMED (5 + 7)
  });

  it('decisiveRate is a ratio-of-sums, NOT the average of per-shard rates', () => {
    const m = mergeLeagueShards([a, b]);
    expect(m.leagueStats.decisiveRate).toBeCloseTo(81 / 100, 10); // 0.81
    const naiveAverage = (a.leagueStats.decisiveRate + b.leagueStats.decisiveRate) / 2; // ≈0.494
    expect(m.leagueStats.decisiveRate).not.toBeCloseTo(naiveAverage, 2);
  });

  it('treats emptyLeagueShard as an additive identity (the workers>episodes path)', () => {
    const empty = mergeLeagueShards([emptyLeagueShard()]);
    expect(empty.learnerDecisions).toBe(0);
    expect(empty.leagueStats.decisiveRate).toBe(0);
    expect(Number.isNaN(empty.leagueStats.decisiveRate)).toBe(false); // 0/0 guarded → 0, not NaN
    // realShard + empty === realShard alone (no field dropped/renamed → no silent NaN).
    expect(mergeLeagueShards([a, emptyLeagueShard()])).toEqual(mergeLeagueShards([a]));
  });
});

describe('projectBudget', () => {
  it('applies the throughput-probe GREEN/YELLOW/RED thresholds (12h unit)', () => {
    const perSec = s12 => s12 / (12 * 3600);
    expect(projectBudget(perSec(2e6)).verdict).toBe('GREEN'); // exactly 2M → GREEN (>=)
    expect(projectBudget(perSec(2e6 - 1)).verdict).toBe('YELLOW');
    expect(projectBudget(perSec(5e5)).verdict).toBe('YELLOW'); // exactly 0.5M → YELLOW (>=)
    expect(projectBudget(perSec(5e5 - 1)).verdict).toBe('RED');
    expect(projectBudget(100).steps12h).toBeCloseTo(100 * 12 * 3600, 6);
  });
});

describe('steadyStateSec (cold-start-excluded throughput basis — the B5 review must-fix)', () => {
  it('uses the MAX per-shard elapsedMs (concurrent shards), NOT the sum and NOT the wall', () => {
    // Concurrent shards: steady-state wall ≈ the slowest shard's loop. Sum (0.4s) or wall would deflate
    // stepsPerSec and could falsely downgrade a GREEN verdict — the exact bug the must-fix addressed.
    expect(steadyStateSec([{ elapsedMs: 100 }, { elapsedMs: 300 }], 9999)).toBeCloseTo(0.3, 10);
  });
  it('ignores zero-elapsed (empty / workers>episodes) shards', () => {
    expect(steadyStateSec([{ elapsedMs: 0 }, { elapsedMs: 200 }], 9999)).toBeCloseTo(0.2, 10);
  });
  it('falls back to wallMs ONLY when every shard is zero-elapsed (and on an empty shard list)', () => {
    expect(steadyStateSec([{ elapsedMs: 0 }], 500)).toBeCloseTo(0.5, 10);
    expect(steadyStateSec([], 500)).toBeCloseTo(0.5, 10);
  });
});

describe('assertPoolCapFitsPool (no-eviction premise)', () => {
  it('passes when poolCap >= poolSize', () => {
    expect(() => assertPoolCapFitsPool(40, 8)).not.toThrow();
    expect(() => assertPoolCapFitsPool(8, 8)).not.toThrow(); // exactly equal → no eviction
  });
  it('throws when poolCap < poolSize (eviction would shrink/skew the field and crash the R-sweep)', () => {
    expect(() => assertPoolCapFitsPool(2, 6)).toThrow(/--pool-cap 2 < pool size 6/);
  });
});

describe('entrypoint arg parsing', () => {
  it('parses known flags incl. bare --json, and rejects unknown', () => {
    const opts = parseArgs(['--players=7', '--r-sweep=0,3,4', '--json']);
    expect(opts.players).toBe('7');
    expect(opts['r-sweep']).toBe('0,3,4');
    expect(opts.json).toBe('true');
    expect(() => parseArgs(['--bogus=1'])).toThrow(/Unknown flag --bogus/);
    expect(() => parseArgs(['notaflag'])).toThrow(/Malformed argument/);
  });

  it('numArg defaults and rejects non-finite', () => {
    expect(numArg({}, 'players', 7)).toBe(7);
    expect(numArg({ players: '8' }, 'players', 7)).toBe(8);
    expect(() => numArg({ players: 'x' }, 'players', 7)).toThrow(/not a finite number/);
  });

  it('parseRSweep parses a list, falls back to a single R, and rejects negatives/non-ints', () => {
    expect(parseRSweep({ 'r-sweep': '0,2,3,4' }, 3)).toEqual([0, 2, 3, 4]);
    expect(parseRSweep({}, 3)).toEqual([3]);
    expect(() => parseRSweep({ 'r-sweep': '3,-1' }, 3)).toThrow(/non-negative integer/);
    expect(() => parseRSweep({ 'r-sweep': '3,1.5' }, 3)).toThrow(/non-negative integer/);
  });
});
