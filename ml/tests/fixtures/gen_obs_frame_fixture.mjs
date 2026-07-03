/**
 * Generate the cross-language golden frame fixture for `dicewars_ppo.wire`.
 *
 * Writes `obs_frame_v<ENCODING_VERSION>.bin` (the exact bytes `serializeObsFrame`
 * produces) and `.json` (the same values as plain JSON) next to this file, PLUS
 * the shaped-frame pair `_shaped.bin`/`.json` ("bite G": the dense-reward
 * header tail). The Python test (`ml/tests/test_ppo_wire.py`) parses each `.bin` and
 * asserts every field equals the `.json` — a hermetic, byte-exact check that the
 * Python parser matches the JS serializer, with NO live Node process at test time.
 *
 * Re-run after any change to `scripts/lib/obs-frame.mjs` or the v-bump:
 *   node ml/tests/fixtures/gen_obs_frame_fixture.mjs
 * On an ENCODING_VERSION bump, also update the GOLDEN_* and SHAPED_* fixture paths
 * in ml/tests/test_ppo_wire.py and delete the old-version fixture files.
 *
 * The frame is SYNTHETIC (small, hand-built, deterministic) — it bypasses the
 * engine/encoder so the fixture is engine-independent and uses values that are
 * exact in f32 (integers and negative-power-of-two fractions). It still flows
 * through the real `serializeObsFrame`, so the byte layout under test is real.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BOARD_FEATURES,
  EDGE_FEATURES,
  ENCODING_VERSION,
  NODE_FEATURES,
  PLAYER_FEATURES,
} from '../../../src/arena/encodeObservation.js';
import { OBS_FRAME_MAGIC, serializeObsFrame } from '../../../scripts/lib/obs-frame.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const maxAreas = 3;
const playerCount = 2;
const numEdges = 2; // one attack + STOP

/*
 * Distinctive, f32-exact values (row*10 + col) so a column/row transposition or
 * an endianness bug is obvious in the failure diff.
 */
const rows = (h, w, base) =>
  Array.from({ length: h }, (_row, r) => Array.from({ length: w }, (_col, c) => base + r * 10 + c));

const frame = {
  magic: OBS_FRAME_MAGIC,
  encodingVersion: ENCODING_VERSION,
  maxAreas,
  playerCount,
  numEdges,
  activePlayerId: 0,
  turnNumber: 5,
  terminal: 0,
  winner: -1,
  won: 0,
  truncated: 0,
  placement: 0,
  // Widths derive from the live FEATURE arrays so the generator tracks a v-bump;
  // the emitted filenames carry the version, so stale goldens can't be mistaken.
  nodes: rows(maxAreas, NODE_FEATURES.length, 0),
  players: rows(playerCount, PLAYER_FEATURES.length, 100),
  board: Array.from({ length: BOARD_FEATURES.length }, (_, c) => 200 + c),
  edges: [
    // an attack (isStop=0): f32-exact dyadic fractions, one per column
    Array.from({ length: EDGE_FEATURES.length }, (_, c) => (c === 3 ? 0 : (c + 1) / 16)),
    // STOP (isStop=1, col 3)
    Array.from({ length: EDGE_FEATURES.length }, (_, c) => (c === 3 ? 1 : 0)),
  ],
  edgeIndex: [
    [1, 2], // attack from id 1 → id 2
    [0, 0], // STOP row
  ],
};

const stem = `obs_frame_v${ENCODING_VERSION}`;
const bytes = serializeObsFrame(frame);
writeFileSync(path.join(HERE, `${stem}.bin`), bytes);
writeFileSync(path.join(HERE, `${stem}.json`), `${JSON.stringify(frame, null, 2)}\n`);

/*
 * Shaped variant ("bite G"): the SAME base frame plus the dense-reward header tail. An exactly-
 * f32-representable dyadic deltaTerritory (-5/2) and an integer elimsByLearner make a layout/
 * endianness bug obvious. `shaped: true` makes serializeObsFrame emit the 56-byte header.
 */
const shapedFrame = {
  ...frame,
  shaped: true,
  deltaTerritory: -2.5, // net territory change since the prior frame (negative = land lost)
  elimsByLearner: 3, // players the learner eliminated since the prior frame
};
const shapedBytes = serializeObsFrame(shapedFrame);
writeFileSync(path.join(HERE, `${stem}_shaped.bin`), shapedBytes);
writeFileSync(path.join(HERE, `${stem}_shaped.json`), `${JSON.stringify(shapedFrame, null, 2)}\n`);

process.stdout.write(
  `wrote ${stem}.bin (${bytes.byteLength} bytes) + ${stem}.json + ` +
    `${stem}_shaped.bin (${shapedBytes.byteLength} bytes) + ${stem}_shaped.json\n`
);
