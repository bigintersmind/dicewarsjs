/**
 * Tier-1 hermetic acceptance test for the [D-29] strength-curve scorer
 * (STRENGTH_CURVE.md "Acceptance test", tier 1): a synthetic index.jsonl built
 * from existing exports of KNOWN relative strength — `ppoPolicyWeights.js`
 * (~+27 vs Lookahead) as an early "step", `bcPolicyWeights.js` (the −3.7 BC
 * anchor) twice as later "steps" — graded with REAL arena games at a reduced
 * budget. Asserts the scorer walks the stream, parity-checks, tallies both
 * in-field references, emits rows + provenance, the run-paired regression
 * detector fires on the descending pair, and a deliberately corrupted fixture
 * yields a `parity-failed` row, not a crash.
 *
 * This file runs a few hundred real games (~1–2 min) — it is the acceptance
 * gate for the scorer, not a unit suite; the fast logic tests live in
 * strengthCurveCore.test.js.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runMatch } from '../../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { makeBC } from '../../src/ai/ai_bc.js';
import { SUPPORTED_ENCODING_VERSIONS } from '../../src/arena/encodeObservation.js';
import { loadExportedPolicy } from '../../scripts/lib/load-bc-policy.mjs';
import {
  CANDIDATE_KEY,
  analyzeCurve,
  gradeCheckpoint,
  parseIndex,
  planCurveWork,
  readStrengthRows,
  renderAnalysis,
  toCsv,
  writeRowsAtomic,
} from '../../scripts/lib/strength-curve-core.mjs';

const repo = p => resolve(process.cwd(), p);
const PPO_WEIGHTS = repo('src/ai/ppoPolicyWeights.js');
const PPO_FIXTURE = repo('tests/fixtures/bc/ppoForwardCases.json');
const BC_WEIGHTS = repo('src/ai/bcPolicyWeights.js');
const BC_FIXTURE = repo('tests/fixtures/bc/forwardCases.json');

// Reduced budget, tuned so the descending pair robustly tests significantly
// below the running best's lower CI bound: the drop is ~28 pp, and at
// 10 runs x 27 games the paired test's expected t is ≈ −5 (vs crit −1.833) —
// far enough from the boundary that the unseeded field bots' game-outcome
// noise can't flip the verdict (8 x 18 left only ~1 t-unit of margin and
// flaked in practice).
const KNOBS = { runs: 10, games: 27, seedBase: 0 };

const deps = {
  loadPolicy: loadExportedPolicy,
  makeBot: makeBC,
  builtInBots: BUILT_IN_BOTS,
  matchFn: runMatch,
  supportedEncodingVersions: SUPPORTED_ENCODING_VERSIONS,
};

let evalDir;
let rows;

beforeAll(async () => {
  evalDir = mkdtempSync(join(tmpdir(), 'curve-e2e-'));

  // A deliberately corrupted parity fixture: same shape, one poisoned logit.
  const corrupted = JSON.parse(readFileSync(PPO_FIXTURE, 'utf8'));
  corrupted.cases[0].logits[0] += 5;
  const corruptedPath = join(evalDir, 'corrupted.fixture.json');
  writeFileSync(corruptedPath, JSON.stringify(corrupted));

  const index = [
    { id: 'eval-1M', step: 1_000_000, weights: PPO_WEIGHTS, fixture: PPO_FIXTURE },
    { id: 'eval-2M', step: 2_000_000, weights: BC_WEIGHTS, fixture: BC_FIXTURE },
    { id: 'eval-3M', step: 3_000_000, weights: BC_WEIGHTS, fixture: BC_FIXTURE },
    { id: 'eval-4M', step: 4_000_000, weights: PPO_WEIGHTS, fixture: corruptedPath },
  ];
  writeFileSync(join(evalDir, 'index.jsonl'), `${index.map(r => JSON.stringify(r)).join('\n')}\n`);

  const { rows: indexRows, warnings } = parseIndex(
    readFileSync(join(evalDir, 'index.jsonl'), 'utf8')
  );
  expect(warnings).toEqual([]);
  const plan = planCurveWork({ indexRows, existingRows: [] });
  expect(plan.toGrade).toHaveLength(4);

  rows = [];
  for (const indexRow of plan.toGrade) {
    const res = await gradeCheckpoint({ indexRow, evalDir, knobs: KNOBS, refNames: ['PPO'], deps });
    expect(res.kind).toBe('row'); // nothing here is not-synced or encoding-incompatible
    rows.push(res.row);
  }
}, 600_000);

describe('strength-curve E2E (tier-1 acceptance)', () => {
  it('grades the healthy checkpoints with per-run arrays for candidate + both references', () => {
    const ok = rows.filter(r => r.status === 'ok');
    expect(ok.map(r => r.step)).toEqual([1_000_000, 2_000_000, 3_000_000]);
    for (const row of ok) {
      expect(row.perRunWin[CANDIDATE_KEY]).toHaveLength(KNOBS.runs);
      expect(row.perRunWin.Lookahead).toHaveLength(KNOBS.runs);
      expect(row.perRunWin.PPO).toHaveLength(KNOBS.runs);
      expect(row.perRunPlacement).toHaveLength(KNOBS.runs);
      expect(row.parity).toBeLessThan(1e-3);
      expect(row.weightsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.games).toBe(KNOBS.runs * 3 * 9); // seedsPerRun 3 x 9 rotations x 10 runs
      expect(['BEAT', 'TIE', 'BEHIND']).toContain(row.verdictVsLook);
      expect(row.verdictVsPPO).toBeDefined();
    }
  });

  it('records the corrupted-fixture checkpoint as parity-failed, not a crash', () => {
    const failed = rows.find(r => r.step === 4_000_000);
    expect(failed.status).toBe('parity-failed');
    expect(failed.error).toMatch(/parity FAIL/);
  });

  it('measures the known strength ordering (PPO checkpoint far above the BC anchor)', () => {
    const ppoPoint = rows.find(r => r.step === 1_000_000);
    const bcPoint = rows.find(r => r.step === 2_000_000);
    expect(ppoPoint.deltaVsLook.mean).toBeGreaterThan(bcPoint.deltaVsLook.mean + 10);
  });

  it('fires the run-paired k=2 regression detector on the descending pair', () => {
    const analysis = analyzeCurve(rows);
    expect(analysis.best.step).toBe(1_000_000);
    expect(analysis.regressions).toHaveLength(1);
    expect(analysis.regressions[0].steps).toEqual([2_000_000, 3_000_000]);
    expect(analysis.regressions[0].refStep).toBe(1_000_000);
    const text = renderAnalysis(analysis, { knobs: KNOBS, evalDir }).join('\n');
    expect(text).toContain('REGRESSION');
    expect(text).toContain('Confirmation protocol');
  });

  it('persists and replans incrementally: rows survive a roundtrip, nothing regrades, rollbacks drop', () => {
    const outPath = join(evalDir, 'strength.jsonl');
    writeRowsAtomic(outPath, rows);
    const back = readStrengthRows(outPath);
    expect(back.rows).toHaveLength(4);
    expect(back.warnings).toEqual([]);

    const { rows: indexRows } = parseIndex(readFileSync(join(evalDir, 'index.jsonl'), 'utf8'));
    const again = planCurveWork({ indexRows, existingRows: back.rows });
    expect(again.toGrade).toEqual([]); // parity-failed rows count as graded — no thrash

    const rolledBack = planCurveWork({
      indexRows: indexRows.filter(r => r.step !== 3_000_000),
      existingRows: back.rows,
    });
    expect(rolledBack.dropped.map(r => r.step)).toEqual([3_000_000]);

    const csv = toCsv(back.rows);
    expect(csv).toContain('eval-1M');
    expect(csv).toContain('parity-failed');
  });
});
