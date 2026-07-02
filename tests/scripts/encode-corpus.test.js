/**
 * Tests for the tensor-expansion pass (scripts/encode-corpus.mjs).
 *
 * Node environment (touches fs + child_process, no DOM). Generates a tiny lean
 * corpus in-process, runs the CLI, and asserts the packed binary round-trips
 * against a fresh encodeStep — so the on-disk format, the CSR edge layout, and
 * the streaming writer are all regression-guarded.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generateShard, resolveSeats, rangeToSeeds } from '../../scripts/lib/selfplay-core.mjs';
import { deserializeTrajectory, trajectoryFromReplay } from '../../src/arena/trajectoryExport.js';
import { encodeStep, teacherSeatsOf } from '../../src/arena/encodeObservation.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-corpus-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Read a packed blob back as a typed array (copied for safe alignment). */
function readTyped(p, Ctor) {
  const b = fs.readFileSync(p);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Ctor(ab);
}

/**
 * Generate a tiny clean corpus with two Lookahead seats (so multi-seat teacher
 * filtering is exercised) using the deterministic seed-pure field, write JSONL.
 */
function makeCorpus(file) {
  const { bots } = resolveSeats(['Lookahead', 'Strategist', 'Lookahead', 'Defensive']);
  const lines = [];
  generateShard({
    bots: bots.map(b => ({ name: b.name, fn: b.fn })),
    seeds: rangeToSeeds(1, 3),
    maxTurns: 500,
    write: s => lines.push(s),
  });
  fs.writeFileSync(file, lines.join(''));
  return lines.length;
}

describe('encode-corpus CLI end-to-end', () => {
  it('expands a lean corpus to packed tensors that round-trip exactly', () => {
    const corpus = path.join(tmpDir, 'corpus.jsonl');
    const games = makeCorpus(corpus);
    expect(games).toBeGreaterThan(0);

    const outDir = path.join(tmpDir, 'encoded');
    execFileSync(
      'node',
      ['scripts/encode-corpus.mjs', '--in', corpus, '--out', outDir, '--teacher', 'Lookahead'],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.encodingVersion).toBe(3);
    expect(manifest.teacher).toBe('Lookahead');
    expect(manifest.dims.playerCount).toBe(4);
    expect(manifest.counts.games).toBe(games);
    expect(manifest.counts.gamesWithTeacher).toBe(games); // every game has Lookahead seats
    expect(manifest.counts.steps).toBeGreaterThan(0);

    // Every blob's byte size matches its declared dtype×shape (4 bytes per element).
    for (const [name, { shape }] of Object.entries(manifest.files)) {
      const elems = shape.reduce((a, b) => a * b, 1);
      expect(fs.statSync(path.join(outDir, name)).size).toBe(elems * 4);
    }

    // CSR offsets: length steps+1, start 0, monotonic non-decreasing, end at totalEdges.
    const offsets = readTyped(path.join(outDir, 'edge_offsets.i32'), Int32Array);
    expect(offsets.length).toBe(manifest.counts.steps + 1);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(manifest.counts.totalEdges);
    for (let i = 1; i < offsets.length; i++)
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);

    /*
     * Binary round-trip: the first packed step equals a fresh encodeStep of the
     * first teacher step re-derived from the corpus.
     */
    const { maxAreas, playerCount, nodeFeatures, playerFeatures, edgeFeatures } = manifest.dims;
    const nodes = readTyped(path.join(outDir, 'nodes.f32'), Float32Array);
    const players = readTyped(path.join(outDir, 'players.f32'), Float32Array);
    const board = readTyped(path.join(outDir, 'board.f32'), Float32Array);
    const edges = readTyped(path.join(outDir, 'edges.f32'), Float32Array);
    const edgeIndex = readTyped(path.join(outDir, 'edge_index.i32'), Int32Array);
    const labels = readTyped(path.join(outDir, 'labels.i32'), Int32Array);
    const value = readTyped(path.join(outDir, 'value.f32'), Float32Array);

    const record = deserializeTrajectory(fs.readFileSync(corpus, 'utf-8').split('\n')[0]);
    const seats = teacherSeatsOf(record, 'Lookahead');
    expect(seats).toEqual([0, 2]); // Lookahead#1 at seat 0, Lookahead#2 at seat 2
    const ctx = {
      maxAreas: record.config.maxAreas,
      playerCount: record.config.playerCount,
      winner: record.metadata.winner,
      placements: record.metadata.placements,
    };
    const firstStep = trajectoryFromReplay(record).find(s => seats.includes(s.playerId));
    const enc = encodeStep(firstStep, ctx);

    const close = (a, b) => Math.abs(a - b) < 1e-6;
    const sliceEq = (typed, start, expected) =>
      expected.every((x, i) => close(typed[start + i], x));

    expect(sliceEq(nodes, 0, enc.nodes.flat())).toBe(true);
    expect(nodes.length).toBe(manifest.counts.steps * maxAreas * nodeFeatures);
    expect(sliceEq(players, 0, enc.players.flat())).toBe(true);
    expect(players.length).toBe(manifest.counts.steps * playerCount * playerFeatures);
    expect(sliceEq(board, 0, enc.board)).toBe(true);

    const e0 = offsets[0];
    const e1 = offsets[1];
    expect(sliceEq(edges, e0 * edgeFeatures, enc.edges.flat())).toBe(true);
    expect(Array.from(edgeIndex.slice(e0 * 2, e1 * 2))).toEqual(enc.edgeIndex.flat());
    expect(labels[0]).toBe(enc.label);
    expect(close(value[0], enc.value.won)).toBe(true);
    expect(close(value[1], enc.value.placement)).toBe(true);
  }, 60_000);

  it('exits non-zero when no seat matches the teacher', () => {
    const corpus = path.join(tmpDir, 'corpus.jsonl');
    makeCorpus(corpus);
    let threw = false;
    let stderr = '';
    try {
      execFileSync(
        'node',
        [
          'scripts/encode-corpus.mjs',
          '--in',
          corpus,
          '--teacher',
          'Nonexistent',
          '--out',
          path.join(tmpDir, 'e'),
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' }
      );
    } catch (err) {
      threw = true;
      stderr = String(err.stderr);
    }
    expect(threw).toBe(true);
    expect(stderr).toMatch(/No teacher steps/);
  }, 60_000);

  it('exits non-zero on a corpus that mixes field dimensions', () => {
    /*
     * Records with different player counts can't pack into one fixed-width blob;
     * the CLI must reject the mixed corpus rather than emit a corrupt artifact.
     */
    const lineFor = names => {
      const { bots } = resolveSeats(names);
      const out = [];
      generateShard({
        bots: bots.map(b => ({ name: b.name, fn: b.fn })),
        seeds: rangeToSeeds(1, 5),
        maxTurns: 500,
        write: s => out.push(s),
      });
      expect(out.length).toBeGreaterThan(0);
      return out[0]; // serialized line already carries its trailing newline
    };
    const corpus = path.join(tmpDir, 'mixed.jsonl');
    // A 4-player game then a 3-player game → differing playerCount.
    fs.writeFileSync(
      corpus,
      lineFor(['Lookahead', 'Strategist', 'Lookahead', 'Defensive']) +
        lineFor(['Lookahead', 'Strategist', 'Defensive'])
    );

    let threw = false;
    let stderr = '';
    try {
      execFileSync(
        'node',
        ['scripts/encode-corpus.mjs', '--in', corpus, '--out', path.join(tmpDir, 'mixed-out')],
        { cwd: REPO_ROOT, stdio: 'pipe' }
      );
    } catch (err) {
      threw = true;
      stderr = String(err.stderr);
    }
    expect(threw).toBe(true);
    expect(stderr).toMatch(/dimension mismatch/);
  }, 60_000);

  it('exits non-zero when --in is missing', () => {
    let threw = false;
    let stderr = '';
    try {
      execFileSync('node', ['scripts/encode-corpus.mjs'], { cwd: REPO_ROOT, stdio: 'pipe' });
    } catch (err) {
      threw = true;
      stderr = String(err.stderr);
    }
    expect(threw).toBe(true);
    expect(stderr).toMatch(/--in .* is required/);
  });
});
