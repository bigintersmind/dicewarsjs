#!/usr/bin/env node

/**
 * Tensor-Expansion Pass (ML-bot Phase 2)
 *
 * Expands a *lean* self-play corpus (`scripts/selfplay.mjs` output: seed +
 * action list + terminal label per game) into the fixed-shape numeric tensors
 * the behavioral-cloning net trains on, exactly per the **D-Encoding** contract
 * (`docs/ml-bot/DECISIONS.md`). Built per D-13's "expand lean → packed tensors":
 *
 *   - **Re-derivation, not re-simulation of bots.** Each game's fat steps are
 *     reproduced from its recorded action list via `trajectoryFromReplay`
 *     (engine determinism), so the expansion is exact and bot-agnostic — it works
 *     even on records made by `Math.random` bots, since we replay stored moves.
 *   - **Teacher-seat filter.** Only steps for the imitated seat(s) (`--teacher`,
 *     default `Lookahead`; base name, `#n` duplicate-seat suffix stripped) are
 *     emitted — the BC label is that seat's `chosenMove`.
 *   - **Streaming, RAM-bounded.** Lines are read one at a time and each step's
 *     tensors are written straight to disk, so an 8M-step corpus never lands in
 *     memory at once.
 *   - **NumPy-loadable packed output.** Dense node/global/board tensors + a CSR
 *     edge layout (ragged legal sets concatenated with row offsets) in raw
 *     little-endian `.f32`/`.i32` blobs, described by a `manifest.json`. Load in
 *     Python with `np.fromfile(..., dtype='<f4'|'<i4').reshape(...)`.
 *
 * Usage:
 *   npm run encode-corpus -- --in data/selfplay/corpus-fullfield-300.jsonl
 *   npm run encode-corpus -- --in <corpus.jsonl> --out data/selfplay/encoded/run-a --teacher Lookahead
 *   npm run encode-corpus -- --in <corpus.jsonl> --limit 50      # first 50 games only
 *
 * @module scripts/encode-corpus
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  deserializeTrajectory,
  trajectoryFromReplay,
  OBSERVATION_SCHEMA_VERSION,
} from '../src/arena/trajectoryExport.js';
import {
  ENCODING_VERSION,
  NODE_FEATURES,
  PLAYER_FEATURES,
  BOARD_FEATURES,
  EDGE_FEATURES,
  encodeStep,
  teacherSeatsOf,
} from '../src/arena/encodeObservation.js';
import { getArg, hasFlag, colors } from './lib/cli-utils.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// --- Parse CLI args ---

const args = process.argv.slice(2);

if (hasFlag(args, 'help')) {
  printHelp();
  process.exit(0);
}

const inArg = getArg(args, 'in');
if (!inArg) fail('--in <corpus.jsonl> is required.');
const inPath = path.resolve(ROOT, inArg);
if (!fs.existsSync(inPath)) fail(`Corpus not found: ${displayPath(inPath)}`);

const teacher = getArg(args, 'teacher', 'Lookahead');

const limitArg = getArg(args, 'limit');
const limit = limitArg === null ? Infinity : parseInt(limitArg, 10);
if (!(limit > 0)) fail('--limit must be a positive integer.');

const defaultOutDir = path.join(
  ROOT,
  'data',
  'selfplay',
  'encoded',
  path.basename(inPath).replace(/\.jsonl$/i, '')
);
const outDir = path.resolve(ROOT, getArg(args, 'out', defaultOutDir));

// --- Run ---

console.log(
  `${colors.bold}Tensor-expansion pass (ML-bot Phase 2)${colors.reset}\n` +
    `  Corpus:  ${displayPath(inPath)}\n` +
    `  Teacher: ${teacher}\n` +
    `  Output:  ${displayPath(outDir)}\n`
);

fs.mkdirSync(outDir, { recursive: true });

// One write stream per packed blob (see manifest for shapes/dtypes/layout).
const streams = {
  nodes: fs.createWriteStream(path.join(outDir, 'nodes.f32')),
  players: fs.createWriteStream(path.join(outDir, 'players.f32')),
  board: fs.createWriteStream(path.join(outDir, 'board.f32')),
  edges: fs.createWriteStream(path.join(outDir, 'edges.f32')),
  edgeIndex: fs.createWriteStream(path.join(outDir, 'edge_index.i32')),
  edgeOffsets: fs.createWriteStream(path.join(outDir, 'edge_offsets.i32')),
  labels: fs.createWriteStream(path.join(outDir, 'labels.i32')),
  value: fs.createWriteStream(path.join(outDir, 'value.f32')),
  meta: fs.createWriteStream(path.join(outDir, 'meta.i32')),
};

let dims = null; // { maxAreas, playerCount } — captured from the first record, asserted uniform after
let games = 0;
let gamesWithTeacher = 0;
let steps = 0;
let totalEdges = 0;
const startTime = Date.now();

// CSR row pointers start at 0; we append one cumulative offset per emitted step.
await writeChunk(streams.edgeOffsets, i32([0]));

const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });

let lineNo = 0;
for await (const line of rl) {
  lineNo++;
  if (!line.trim()) continue;
  if (games >= limit) break;

  let record;
  try {
    record = deserializeTrajectory(line);
  } catch (err) {
    fail(`Line ${lineNo}: ${err.message}`);
  }
  games++;

  /*
   * The packed tensors are fixed-width, so every game in one run must share the
   * same node width and seat count. Capture from the first game, then fail loudly
   * on any mismatch (a corpus mixing 4p and 7p fields can't pack into one blob).
   */
  const recordDims = { maxAreas: record.config.maxAreas, playerCount: record.config.playerCount };
  if (dims === null) {
    dims = recordDims;
  } else if (recordDims.maxAreas !== dims.maxAreas || recordDims.playerCount !== dims.playerCount) {
    fail(
      `Line ${lineNo}: dimension mismatch — corpus has both ` +
        `${dims.maxAreas}×${dims.playerCount}p and ${recordDims.maxAreas}×${recordDims.playerCount}p games. ` +
        `Encode each field separately.`
    );
  }

  const seats = teacherSeatsOf(record, teacher);
  if (seats.length === 0) continue;
  gamesWithTeacher++;

  const ctx = {
    maxAreas: record.config.maxAreas,
    playerCount: record.config.playerCount,
    winner: record.metadata.winner,
    placements: record.metadata.placements,
  };

  let fatSteps;
  try {
    fatSteps = trajectoryFromReplay(record);
  } catch (err) {
    fail(`Line ${lineNo} (seed ${record.config.seed}): re-derivation failed — ${err.message}`);
  }

  for (const step of fatSteps) {
    if (!seats.includes(step.playerId)) continue;

    let enc;
    try {
      enc = encodeStep(step, ctx);
    } catch (err) {
      fail(`Line ${lineNo} (seed ${record.config.seed}): encode failed — ${err.message}`);
    }

    await writeChunk(streams.nodes, f32(enc.nodes.flat()));
    await writeChunk(streams.players, f32(enc.players.flat()));
    await writeChunk(streams.board, f32(enc.board));
    await writeChunk(streams.edges, f32(enc.edges.flat()));
    await writeChunk(streams.edgeIndex, i32(enc.edgeIndex.flat()));
    await writeChunk(streams.labels, i32([enc.label]));
    await writeChunk(streams.value, f32([enc.value.won, enc.value.placement]));
    await writeChunk(streams.meta, i32([games - 1, enc.playerId, enc.turnNumber]));

    steps++;
    totalEdges += enc.edges.length;
    await writeChunk(streams.edgeOffsets, i32([totalEdges]));
  }

  if (games % 100 === 0) {
    process.stdout.write(`\rGames: ${games} · teacher steps: ${steps}`);
  }
}

await Promise.all(Object.values(streams).map(closeStream));

if (steps === 0) {
  fail(
    `No teacher steps emitted — does the corpus contain a "${teacher}" seat? ` +
      `(${games} games read, ${gamesWithTeacher} with a teacher seat).`
  );
}

const manifest = {
  encodingVersion: ENCODING_VERSION,
  observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
  source: path.basename(inPath),
  teacher,
  counts: { games, gamesWithTeacher, steps, totalEdges },
  dims: {
    maxAreas: dims.maxAreas,
    playerCount: dims.playerCount,
    nodeFeatures: NODE_FEATURES.length,
    playerFeatures: PLAYER_FEATURES.length,
    boardFeatures: BOARD_FEATURES.length,
    edgeFeatures: EDGE_FEATURES.length,
  },
  featureNames: {
    node: NODE_FEATURES,
    player: PLAYER_FEATURES,
    board: BOARD_FEATURES,
    edge: EDGE_FEATURES,
  },
  byteOrder: 'little-endian',
  files: {
    'nodes.f32': { dtype: '<f4', shape: [steps, dims.maxAreas, NODE_FEATURES.length] },
    'players.f32': { dtype: '<f4', shape: [steps, dims.playerCount, PLAYER_FEATURES.length] },
    'board.f32': { dtype: '<f4', shape: [steps, BOARD_FEATURES.length] },
    'edges.f32': { dtype: '<f4', shape: [totalEdges, EDGE_FEATURES.length] },
    'edge_index.i32': { dtype: '<i4', shape: [totalEdges, 2] },
    'edge_offsets.i32': { dtype: '<i4', shape: [steps + 1] },
    'labels.i32': { dtype: '<i4', shape: [steps] },
    'value.f32': { dtype: '<f4', shape: [steps, 2] },
    'meta.i32': { dtype: '<i4', shape: [steps, 3] },
  },
  notes: [
    'Edges use a CSR layout: step i owns edge rows edge_offsets[i]:edge_offsets[i+1] ' +
      'in edges.f32 / edge_index.i32. edge_offsets has length steps+1, edge_offsets[0]=0.',
    'labels[i] is LOCAL to step i (0-based within its edge slice); the global row is ' +
      'edge_offsets[i] + labels[i]. The last edge of every step is STOP (edge feature isStop=1).',
    'edge_index rows are (fromId, toId) territory ids into the node tensor (gather); STOP is (0,0).',
    'value columns are (won, placement); placement is 1=first … 0=last, valid even when winner=null.',
    'meta columns are (gameIndex, playerId, turnNumber); gameIndex enumerates games read from the corpus.',
    'The action mask is implicit: every emitted edge is legal (the legal set is getValidMoves + STOP).',
  ],
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const elapsed = (Date.now() - startTime) / 1000;
const bytes = Object.keys(manifest.files).reduce(
  (sum, name) => sum + statSize(path.join(outDir, name)),
  0
);
process.stdout.write('\n\n');
console.log(`${colors.bold}Done${colors.reset}`);
console.log(`  Games:        ${games} (${gamesWithTeacher} with a ${teacher} seat)`);
console.log(`  Teacher steps:${steps}`);
console.log(`  Edges:        ${totalEdges} (avg ${(totalEdges / steps).toFixed(1)}/step)`);
console.log(
  `  Size:         ${(bytes / 1e6).toFixed(1)} MB across ${Object.keys(streams).length} blobs`
);
console.log(`  Time:         ${elapsed.toFixed(1)}s`);
console.log(
  `\n${colors.green}Wrote packed tensors + manifest.json to ${displayPath(outDir)}${colors.reset}`
);

// --- Helpers ---

/** Flatten a number array into a little-endian Float32 Buffer. */
function f32(arr) {
  const a = Float32Array.from(arr);
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/** Flatten a number array into a little-endian Int32 Buffer. */
function i32(arr) {
  const a = Int32Array.from(arr);
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/** Write a chunk, awaiting backpressure so an 8M-step run can't outrun the fs. */
function writeChunk(stream, buf) {
  return stream.write(buf) ? Promise.resolve() : new Promise(res => stream.once('drain', res));
}

/** Close a write stream, resolving once its data is flushed. */
function closeStream(stream) {
  return new Promise((resolve, reject) => stream.end(err => (err ? reject(err) : resolve())));
}

function statSize(p) {
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

/** Repo-relative path when inside the repo, else the absolute path. */
function displayPath(p) {
  const rel = path.relative(ROOT, p);
  return rel.startsWith('..') ? p : rel;
}

function fail(msg) {
  console.error(`${colors.red}${msg}${colors.reset}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Tensor-expansion pass — expand a lean self-play corpus to packed BC tensors (ML-bot Phase 2)

Usage:
  npm run encode-corpus -- --in <corpus.jsonl> [options]

Options:
  --in <path>       Lean trajectory corpus (.jsonl from scripts/selfplay.mjs) [required]
  --out <dir>       Output directory (default: data/selfplay/encoded/<corpus-basename>)
  --teacher <name>  Bot whose seat(s) to imitate (default: Lookahead; base name, #n stripped)
  --limit <n>       Encode only the first n games (dev runs)
  --help            Show this help

Output: a directory of little-endian packed blobs (nodes/players/board/edges/...) + a
manifest.json describing dtypes, shapes, the CSR edge layout, and feature-column names.
Load in Python via np.fromfile(path, dtype='<f4'|'<i4').reshape(manifest shape).`);
}
