/**
 * Unit tests for scripts/lib/strength-curve-core.mjs — the [D-29] scorer's
 * pure/injectable logic: index walking, incremental work planning, the
 * three-way failure policy, the run-paired k=2 regression / k=3 plateau
 * detectors, provenance, and the jsonl/csv IO. All heavy deps are stubbed;
 * no arena games run here (the E2E acceptance test covers the real thing).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pairedDelta, classifyGate } from '../../scripts/lib/ppo-gate-core.mjs';
import { mean } from '../../scripts/lib/stats.mjs';
import {
  CANDIDATE_KEY,
  analyzeCurve,
  buildMeta,
  checkpointName,
  fieldHash,
  gradeCheckpoint,
  metaMismatches,
  parseIndex,
  perRunDeltaVsRef,
  planCurveWork,
  pointLine,
  readStrengthRows,
  renderAnalysis,
  testsAbove,
  testsBelow,
  toCsv,
  writeRowsAtomic,
} from '../../scripts/lib/strength-curve-core.mjs';

// ---------------------------------------------------------------------------
// Fabricated-row helper: a status:'ok' row whose per-run Δ-vs-Lookahead array
// is exactly `perRunDeltas` (Lookahead pinned at 10, candidate = 10 + Δ).
// ---------------------------------------------------------------------------
function mkRow(step, perRunDeltas, { placement = 5, status = 'ok' } = {}) {
  if (status !== 'ok') {
    return { id: `eval-${step}`, step, status, error: 'stub failure' };
  }
  const look = perRunDeltas.map(() => 10);
  const cand = perRunDeltas.map(d => 10 + d);
  const delta = pairedDelta(cand, look);
  return {
    id: `eval-${step}`,
    step,
    status: 'ok',
    winPct: mean(cand),
    winCi: 1,
    avgPlacement: placement,
    deltaVsLook: { mean: delta.mean, ci: delta.ci, lo: delta.lo, hi: delta.hi },
    verdictVsLook: classifyGate(delta),
    perRunWin: { [CANDIDATE_KEY]: cand, Lookahead: look },
    perRunPlacement: perRunDeltas.map(() => placement),
  };
}

// A mild spread around `m` (n=4, sd ≈ 0.82 → CI ≈ ±1.3)
const around = m => [m - 1, m + 1, m, m];

describe('parseIndex', () => {
  it('parses rows, warns-and-skips garbage, sorts by step, keeps the last dupe', () => {
    const text = [
      '{"id":"eval-2","step":2,"weights":"b.weights.js"}',
      'not json at all',
      '{"id":"eval-1","step":1,"weights":"a.weights.js"}',
      '{"id":"missing-step","weights":"c.weights.js"}',
      '{"id":"eval-2-bis","step":2,"weights":"b2.weights.js"}',
      '',
    ].join('\n');
    const { rows, warnings } = parseIndex(text);
    expect(rows.map(r => r.step)).toEqual([1, 2]);
    expect(rows[1].id).toBe('eval-2-bis');
    expect(warnings).toHaveLength(3); // garbage + missing step + dupe
  });
});

describe('planCurveWork', () => {
  const idx = [1, 2, 3, 4, 5].map(step => ({ id: `eval-${step}`, step, weights: 'w' }));

  it('grades only new steps; failed rows count as graded (producer never re-emits a step)', () => {
    const existing = [mkRow(1, around(5)), mkRow(2, [], { status: 'parity-failed' })];
    const plan = planCurveWork({ indexRows: idx, existingRows: existing });
    expect(plan.toGrade.map(r => r.step)).toEqual([3, 4, 5]);
    expect(plan.dropped).toEqual([]);
    expect(plan.kept).toHaveLength(2);
  });

  it('drops rows whose steps vanished from the index (trainer resume rollback)', () => {
    const existing = [mkRow(1, around(5)), mkRow(99, around(5))];
    const plan = planCurveWork({ indexRows: idx, existingRows: existing });
    expect(plan.dropped.map(r => r.step)).toEqual([99]);
    expect(plan.kept.map(r => r.step)).toEqual([1]);
  });

  it('subsamples positionally with --every-n and defers past --max-points, reporting both', () => {
    const plan = planCurveWork({ indexRows: idx, existingRows: [], everyN: 2, maxPoints: 2 });
    expect(plan.toGrade.map(r => r.step)).toEqual([1, 3]); // ordinals 0, 2
    expect(plan.deferred.map(r => r.step)).toEqual([5]); // ordinal 4, deferred by maxPoints
    expect(plan.skippedBySubsample.map(r => r.step)).toEqual([2, 4]);
    // eligibleSteps = every step this curve is expected to grade under everyN
    expect(plan.eligibleSteps).toEqual([1, 3, 5]);
  });
});

describe('one-sided run-paired tests', () => {
  it('testsBelow: detects a clear drop, respects the shifted null, needs n >= 2', () => {
    expect(testsBelow([-8, -7, -9, -8], 0)).toBe(true);
    expect(testsBelow([-8, -7, -9, -8], -10)).toBe(false); // not below the shifted null
    expect(testsBelow([-8], 0)).toBe(false);
    expect(testsBelow([-5, -5], 0)).toBe(true); // zero-variance fallback
    expect(testsBelow([5, 5], 0)).toBe(false);
  });

  it('testsAbove mirrors testsBelow', () => {
    expect(testsAbove([8, 7, 9, 8], 0)).toBe(true);
    expect(testsAbove([8, 7, 9, 8], 10)).toBe(false);
    expect(testsAbove([0, 0], 0)).toBe(false);
  });

  it('perRunDeltaVsRef pairs candidate and reference arrays by run index', () => {
    const row = mkRow(1, [5, 7, 6, 6]);
    expect(perRunDeltaVsRef(row, 'Lookahead')).toEqual([5, 7, 6, 6]);
    expect(perRunDeltaVsRef(row, 'PPO')).toBeNull();
  });
});

describe('analyzeCurve — the [D-29] detection rules', () => {
  it('flags a regression only at k=2 consecutive significantly-below points', () => {
    const rows = [
      mkRow(1, around(20)),
      mkRow(2, around(21)),
      mkRow(3, around(8)), // one dip — not yet a regression
      mkRow(4, around(8)), // second consecutive — fires
    ];
    const oneDip = analyzeCurve(rows.slice(0, 3));
    expect(oneDip.regressions).toEqual([]);
    const twoDips = analyzeCurve(rows);
    expect(twoDips.regressions).toHaveLength(1);
    expect(twoDips.regressions[0].steps).toEqual([3, 4]);
    expect(twoDips.regressions[0].refStep).toBe(2);
    expect(twoDips.activeSlump?.steps).toEqual([3, 4]);
  });

  it('a failed point breaks the k-consecutive window (gaps never bridge)', () => {
    const rows = [
      mkRow(1, around(20)),
      mkRow(2, around(8)),
      mkRow(3, [], { status: 'parity-failed' }),
      mkRow(4, around(8)),
    ];
    const analysis = analyzeCurve(rows);
    expect(analysis.regressions).toEqual([]);
    expect(analysis.failedPoints).toBe(1);
  });

  it('an indexed-but-ungraded step (artifacts not yet synced) also breaks the window', () => {
    const rows = [mkRow(1, around(20)), mkRow(2, around(8)), mkRow(4, around(8))];
    // Step 3 is expected by the index but has no row at all (awaiting sync):
    // without indexSteps the two dips look consecutive and fire...
    expect(analyzeCurve(rows).regressions).toHaveLength(1);
    // ...with indexSteps the missing point breaks the window, per the spec.
    const gapped = analyzeCurve(rows, { indexSteps: [1, 2, 3, 4] });
    expect(gapped.regressions).toEqual([]);
    // A fully-graded index leaves the detection unchanged.
    const dense = analyzeCurve(rows, { indexSteps: [1, 2, 4] });
    expect(dense.regressions).toHaveLength(1);
  });

  it('reports plateau onset when k=3 following points show no significant paired gain', () => {
    const flat = analyzeCurve([
      mkRow(1, around(20)),
      mkRow(2, around(20)),
      mkRow(3, around(20)),
      mkRow(4, around(20)),
    ]);
    expect(flat.plateauStep).toBe(1);
    const rising = analyzeCurve([
      mkRow(1, around(0)),
      mkRow(2, around(8)),
      mkRow(3, around(16)),
      mkRow(4, around(24)),
    ]);
    expect(rising.plateauStep).toBeNull();
  });

  it('best is the argmax with ties-within-CI called out', () => {
    const analysis = analyzeCurve([
      mkRow(1, around(18)),
      mkRow(2, around(20)),
      mkRow(3, around(19.5)), // within the best's CI
      mkRow(4, around(5)),
    ]);
    expect(analysis.best.step).toBe(2);
    expect(analysis.ties).toContain(3);
    expect(analysis.ties).not.toContain(4);
  });

  it('raises the descriptive divergence flag: placement improving while win% is flat', () => {
    const rows = [
      mkRow(1, around(10), { placement: 5.0 }),
      mkRow(2, around(10), { placement: 5.0 }),
      mkRow(3, around(10), { placement: 4.6 }),
      mkRow(4, around(10), { placement: 4.5 }),
    ];
    expect(analyzeCurve(rows).divergence).not.toBeNull();
    const healthy = [
      mkRow(1, around(10), { placement: 5.0 }),
      mkRow(2, around(12), { placement: 5.0 }),
      mkRow(3, around(14), { placement: 4.6 }),
      mkRow(4, around(16), { placement: 4.5 }),
    ];
    expect(analyzeCurve(healthy).divergence).toBeNull();
  });

  it('handles an empty curve', () => {
    const analysis = analyzeCurve([]);
    expect(analysis.points).toBe(0);
    expect(analysis.best).toBeNull();
  });
});

describe('gradeCheckpoint — the three-way failure policy', () => {
  const stubBuiltIns = [
    { name: 'Lookahead', fn: () => null },
    { name: 'PPO', fn: () => null },
    { name: 'Default', fn: () => null },
  ];
  const okMatch = ({ bots }) => ({
    winnerName: bots[0].name,
    botStats: bots.map((b, i) => ({
      name: b.name,
      placement: i + 1,
      attacksMade: 4,
      attacksWon: 2,
    })),
  });
  const knobs = { runs: 2, games: 4, seedBase: 0 };

  function tempEvalDir() {
    return mkdtempSync(join(tmpdir(), 'curve-core-'));
  }

  function mkDeps(overrides = {}) {
    return {
      loadPolicy: async () => ({ policy: { encodingVersion: 3 }, parity: 1e-5, params: 42 }),
      makeBot: () => () => null,
      builtInBots: stubBuiltIns,
      matchFn: okMatch,
      supportedEncodingVersions: [2, 3],
      ...overrides,
    };
  }

  it('returns not-synced when a referenced artifact file is absent (retry, never an error)', async () => {
    const evalDir = tempEvalDir();
    const res = await gradeCheckpoint({
      indexRow: {
        id: 'eval-1',
        step: 1,
        weights: 'missing.weights.js',
        fixture: 'missing.fixture.json',
      },
      evalDir,
      knobs,
      deps: mkDeps(),
    });
    expect(res.kind).toBe('not-synced');
    expect(res.missing).toHaveLength(2);
  });

  it('emits a parity-failed row when the loader throws on a broken single export', async () => {
    const evalDir = tempEvalDir();
    writeFileSync(join(evalDir, 'a.weights.js'), 'export const nothing = 1;\n');
    writeFileSync(join(evalDir, 'a.fixture.json'), '{}');
    const res = await gradeCheckpoint({
      indexRow: { id: 'eval-1', step: 1, weights: 'a.weights.js', fixture: 'a.fixture.json' },
      evalDir,
      knobs,
      gitSha: 'abc1234',
      deps: mkDeps({
        loadPolicy: async () => {
          throw new Error('parity FAIL for eval-1: maxErr=2e-1 > tol=1e-3');
        },
      }),
    });
    expect(res.kind).toBe('row');
    expect(res.row.status).toBe('parity-failed');
    expect(res.row.error).toMatch(/parity FAIL/);
    // Failed rows still carry per-row provenance: which artifact, at which repo state.
    expect(res.row.weightsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.row.gitSha).toBe('abc1234');
  });

  it('classifies an out-of-support encodingVersion as a run-global abort, even when the loader threw', async () => {
    const evalDir = tempEvalDir();
    writeFileSync(
      join(evalDir, 'v99.weights.js'),
      'export const BC_POLICY = { encodingVersion: 99 };\n'
    );
    writeFileSync(join(evalDir, 'v99.fixture.json'), '{}');
    const viaThrow = await gradeCheckpoint({
      indexRow: { id: 'eval-1', step: 1, weights: 'v99.weights.js', fixture: 'v99.fixture.json' },
      evalDir,
      knobs,
      deps: mkDeps({
        loadPolicy: async () => {
          throw new Error('config.nodeFeatures mismatch');
        },
      }),
    });
    expect(viaThrow.kind).toBe('encoding-abort');
    expect(viaThrow.version).toBe(99);
    expect(viaThrow.reason).toBe('unsupported-version');

    const viaCheck = await gradeCheckpoint({
      indexRow: { id: 'eval-1', step: 1, weights: 'v99.weights.js', fixture: 'v99.fixture.json' },
      evalDir,
      knobs,
      deps: mkDeps({
        loadPolicy: async () => ({ policy: { encodingVersion: 99 }, parity: 0, params: 1 }),
      }),
    });
    expect(viaCheck.kind).toBe('encoding-abort');
    expect(viaCheck.reason).toBe('unsupported-version');
  });

  it('classifies a supported-version makeBC width failure as incompatible-widths, not a version problem', async () => {
    const evalDir = tempEvalDir();
    writeFileSync(
      join(evalDir, 'wide.weights.js'),
      'export const BC_POLICY = { encodingVersion: 3 };\n'
    );
    writeFileSync(join(evalDir, 'wide.fixture.json'), '{}');
    const res = await gradeCheckpoint({
      indexRow: { id: 'eval-1', step: 1, weights: 'wide.weights.js', fixture: 'wide.fixture.json' },
      evalDir,
      knobs,
      deps: mkDeps({
        makeBot: () => {
          throw new Error('policy nodeFeatures 15 exceeds the live encoder width 13');
        },
      }),
    });
    expect(res.kind).toBe('encoding-abort');
    expect(res.version).toBe(3);
    expect(res.reason).toBe('incompatible-widths');
    expect(res.error).toMatch(/exceeds the live encoder/);
  });

  it('emits a sweep-failed row when the sweep itself aborts', async () => {
    const evalDir = tempEvalDir();
    writeFileSync(
      join(evalDir, 'a.weights.js'),
      'export const BC_POLICY = { encodingVersion: 3 };\n'
    );
    writeFileSync(join(evalDir, 'a.fixture.json'), '{}');
    const res = await gradeCheckpoint({
      indexRow: { id: 'eval-1', step: 1, weights: 'a.weights.js', fixture: 'a.fixture.json' },
      evalDir,
      knobs: { runs: 2, games: 8, seedBase: 0 },
      deps: mkDeps({
        matchFn: () => {
          throw new Error('engine exploded');
        },
      }),
    });
    expect(res.kind).toBe('row');
    expect(res.row.status).toBe('sweep-failed');
    expect(res.row.error).toMatch(/matches failed|completed 0/);
  });

  it('grades the happy path: per-run arrays for candidate + both references, provenance fields', async () => {
    const evalDir = tempEvalDir();
    writeFileSync(
      join(evalDir, 'a.weights.js'),
      'export const BC_POLICY = { encodingVersion: 3 };\n'
    );
    writeFileSync(join(evalDir, 'a.fixture.json'), '{}');
    const res = await gradeCheckpoint({
      indexRow: {
        id: 'eval-5',
        step: 5_000_000,
        weights: 'a.weights.js',
        fixture: 'a.fixture.json',
        createdAt: '2026-07-01T00:00:00Z',
      },
      evalDir,
      knobs,
      refNames: ['PPO'],
      gitSha: 'abc1234',
      deps: mkDeps(),
    });
    expect(res.kind).toBe('row');
    const { row } = res;
    expect(row.status).toBe('ok');
    expect(row.step).toBe(5_000_000);
    expect(row.gitSha).toBe('abc1234');
    expect(row.indexCreatedAt).toBe('2026-07-01T00:00:00Z');
    expect(row.parity).toBe(1e-5);
    expect(row.params).toBe(42);
    expect(row.weightsSha256).toMatch(/^[0-9a-f]{64}$/);
    // field = 3 stubs + CP-5000000 = 4 seats; runs=2
    expect(row.perRunWin[CANDIDATE_KEY]).toHaveLength(2);
    expect(row.perRunWin.Lookahead).toHaveLength(2);
    expect(row.perRunWin.PPO).toHaveLength(2);
    expect(row.perRunPlacement).toHaveLength(2);
    expect(row.games).toBe(2 * 4); // seedsPerRun 1 x 4 rotations x 2 runs
    expect(row.deltaVsLook).toHaveProperty('lo');
    expect(['BEAT', 'TIE', 'BEHIND']).toContain(row.verdictVsLook);
    expect(row.verdictVsPPO).toBeDefined();
    expect(pointLine(row)).toContain('eval-5');
  });
});

describe('pointLine', () => {
  const okRow = { ...mkRow(7, around(12)), games: 153, wallClockSec: 12.3 };

  it('surfaces a decimated sweep (an ok row built from failed games) as a warning', () => {
    // Up to ~50% per-match failures are tolerated before the sweep aborts, so an ok
    // row can hide a thinned/biased game set. The onMatchError noise has scrolled off
    // by summary time — the point line must not read identical to a clean sweep.
    expect(pointLine({ ...okRow, failedGames: 20 })).toContain('20/173 games failed');
  });

  it('omits the decimation note when no games failed', () => {
    expect(pointLine({ ...okRow, failedGames: 0 })).not.toContain('games failed');
  });
});

describe('provenance + IO', () => {
  it('metaMismatches: hard on knobs/field/encoding/refs, soft on gitSha drift', () => {
    const mk = over =>
      buildMeta({
        knobs: { runs: 20, games: 150, seedBase: 0, everyN: 1 },
        baseFieldNames: ['A', 'B'],
        refNames: ['PPO'],
        gitSha: 'abc1234',
        encodingVersion: 3,
        lookaheadPin: '596f781',
        evalDir: 'x',
        ...over,
      });
    const base = mk({});
    expect(metaMismatches(base, mk({})).hard).toEqual([]);
    expect(
      metaMismatches(base, mk({ knobs: { runs: 40, games: 150, seedBase: 0 } })).hard
    ).not.toEqual([]);
    expect(metaMismatches(base, mk({ baseFieldNames: ['A', 'C'] })).hard).not.toEqual([]);
    expect(metaMismatches(base, mk({ encodingVersion: 2 })).hard).not.toEqual([]);
    expect(metaMismatches(base, mk({ refNames: ['PPO', 'Strategist'] })).hard).not.toEqual([]);
    const drift = metaMismatches(base, mk({ gitSha: 'def5678' }));
    expect(drift.hard).toEqual([]);
    expect(drift.gitShaDrift).toBe('abc1234 -> def5678');
  });

  it('fieldHash is order-sensitive (seat order is part of the methodology)', () => {
    expect(fieldHash(['A', 'B'])).not.toBe(fieldHash(['B', 'A']));
  });

  it('writeRowsAtomic/readStrengthRows roundtrip, tolerant of torn lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curve-io-'));
    const path = join(dir, 'strength.jsonl');
    const rows = [mkRow(1, around(5)), mkRow(2, [], { status: 'parity-failed' })];
    writeRowsAtomic(path, rows);
    const back = readStrengthRows(path);
    expect(back.rows).toHaveLength(2);
    expect(back.warnings).toEqual([]);
    // append garbage — the walker must warn-and-skip, not crash
    writeFileSync(path, `${JSON.stringify(rows[0])}\n{"torn`, { flag: 'w' });
    const torn = readStrengthRows(path);
    expect(torn.rows).toHaveLength(1);
    expect(torn.warnings).toHaveLength(1);
  });

  it('toCsv emits summary columns sorted by step, blank cells for failed rows', () => {
    const csv = toCsv([mkRow(2, [], { status: 'parity-failed' }), mkRow(1, around(5))]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toMatch(/^id,step,status,winPct/);
    expect(lines[1]).toMatch(/^eval-1,1,ok,/);
    expect(lines[2]).toMatch(/^eval-2,2,parity-failed,,/);
  });

  it('renderAnalysis prints the regression alert and the mandatory confirmation protocol', () => {
    const rows = [
      mkRow(1, around(20)),
      mkRow(2, around(21)),
      mkRow(3, around(8)),
      mkRow(4, around(8)),
    ];
    const lines = renderAnalysis(analyzeCurve(rows), {
      tbHint: 'ml/runs/x/tb/progress-*.csv',
      knobs: { runs: 20, seedBase: 0 },
      evalDir: 'ml/runs/x/eval',
    });
    const text = lines.join('\n');
    expect(text).toContain('REGRESSION');
    expect(text).toContain('tb/progress-*.csv');
    expect(text).toContain('Confirmation protocol');
    expect(text).toContain("winner's curse");
    expect(text).toContain('ppo:gate');
    expect(checkpointName(123)).toBe('CP-123');
  });
});
