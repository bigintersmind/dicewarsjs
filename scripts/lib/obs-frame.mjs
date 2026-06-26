/**
 * PPO observation-frame wire codec (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * Serializes one live decision observation into a single self-describing binary
 * frame for the Node↔Python PPO bridge, and parses it back. The tensor payload follows
 * the **same little-endian f32/i32 convention** the offline corpus writes
 * (`scripts/encode-corpus.mjs`), minus the corpus-only blobs (labels/value/meta and
 * the CSR `edge_offsets`) — those are a batching concern for a flat multi-step file;
 * a single socket frame carries its own dims in a header instead. (The agreement is a
 * shared convention, not a checked invariant — nothing here re-derives the corpus bytes.)
 *
 * Why a header at all (the corpus has none): the corpus keeps all dims in
 * `manifest.json`; a socket frame has no side-channel manifest, so it MUST prefix
 * its dims. The header is fixed-width little-endian; the variable axis is `numEdges`
 * (legal attacks + 1 trailing STOP).
 *
 * Layout (all little-endian, tightly packed, 4-byte stride, NO alignment padding):
 *
 *   HEADER — 12 fields × 4 bytes = 48 bytes
 *     [ 0] magic           i32  = OBS_FRAME_MAGIC ("DWOB") — sanity/version guard
 *     [ 1] encodingVersion i32  = ENCODING_VERSION (NOT hardcoded; bumps with the encoder)
 *     [ 2] maxAreas        i32  = node-tensor height (policy config.maxAreas)
 *     [ 3] playerCount     i32  = players-tensor height (seat count)
 *     [ 4] numEdges        i32  = N = #legal attacks + 1 STOP (the only variable axis)
 *     [ 5] activePlayerId  i32  = acting seat (botState.myPlayer)
 *     [ 6] turnNumber      i32  = engine turn number
 *     [ 7] terminal        i32  = 0 mid-game (action expected) | 1 terminal (no reply)
 *     [ 8] winner          i32  = winning seat, or -1 (none / stalemate)
 *     [ 9] won             i32  = 1 if the learner won, else 0 (meaningful when terminal=1)
 *     [10] truncated       i32  = 1 if the terminal is a maxTurns stalemate CAP (Gym
 *                                 truncation — bootstrap V(s)), else 0 (a genuine
 *                                 terminal: a win or the learner's elimination). Only
 *                                 meaningful when terminal=1.
 *     [11] placement       f32  = learner placement scaled 1=first … 0=last (terminal=1)
 *   TENSOR PAYLOAD (row-major)
 *     nodes      f32  maxAreas * NODE_FEATURES.length
 *     players    f32  playerCount * PLAYER_FEATURES.length
 *     board      f32  BOARD_FEATURES.length
 *     edges      f32  numEdges * EDGE_FEATURES.length     (last row = STOP = isStop@col3)
 *     edge_index i32  numEdges * 2  (fromId, toId)        (STOP row = [0, 0])
 *
 * There is intentionally NO mask blob: the inference encoder emits only legal edges,
 * so the mask is implicitly all-ones (matching `ai_bc`'s no-mask argmax). A Python
 * rollout that pads to a fixed MAX masks the pad slots agent-side; the wire frame
 * carries exactly N edges.
 *
 * @module scripts/lib/obs-frame
 */

import {
  ENCODING_VERSION,
  NODE_FEATURES,
  PLAYER_FEATURES,
  BOARD_FEATURES,
  EDGE_FEATURES,
} from '../../src/arena/encodeObservation.js';

/** Frame magic: ASCII "DWOB" (DiceWars OBservation) as a little-endian i32. */
export const OBS_FRAME_MAGIC = 0x44574f42;

const NODE_W = NODE_FEATURES.length;
const PLAYER_W = PLAYER_FEATURES.length;
const BOARD_W = BOARD_FEATURES.length;
const EDGE_W = EDGE_FEATURES.length;

const HEADER_FIELDS = 12;
const HEADER_BYTES = HEADER_FIELDS * 4;

/**
 * Assemble the plain frame object the serializer consumes, from the encoder's
 * output plus the acting `botState` and per-frame metadata. Keeps the dims/IDs in
 * exactly one place so the env-server and tests can't disagree on the header.
 *
 * @param {Object} args
 * @param {{nodes:number[][], players:number[][], board:number[], edges:number[][],
 *   edgeIndex:number[][], moves:Array<{from:number,to:number}|null>}} args.encoded
 *   - `encodeObservationForInference` output.
 * @param {import('../../src/arena/types.js').BotState} args.botState - acting seat's observation.
 * @param {number} args.maxAreas - node-tensor height (policy config.maxAreas).
 * @param {number} [args.terminal=0] - 0 mid-game, 1 terminal.
 * @param {number} [args.winner=-1] - winning seat, or -1.
 * @param {number} [args.won=0] - 1 if the learner won.
 * @param {number} [args.truncated=0] - 1 if the terminal is a maxTurns stalemate cap
 *   (Gym truncation), else 0 (genuine terminal). Only meaningful when `terminal=1`.
 * @param {number} [args.placement=0] - scaled placement (1=first … 0=last).
 * @returns {ObsFrame}
 */
export function buildObsFrame({
  encoded,
  botState,
  maxAreas,
  terminal = 0,
  winner = -1,
  won = 0,
  truncated = 0,
  placement = 0,
}) {
  return {
    magic: OBS_FRAME_MAGIC,
    encodingVersion: ENCODING_VERSION,
    maxAreas,
    playerCount: botState.players.length,
    numEdges: encoded.moves.length,
    activePlayerId: botState.myPlayer,
    turnNumber: botState.turnNumber,
    terminal,
    winner,
    won,
    truncated,
    placement,
    nodes: encoded.nodes,
    players: encoded.players,
    board: encoded.board,
    edges: encoded.edges,
    edgeIndex: encoded.edgeIndex,
  };
}

/**
 * @typedef {Object} ObsFrame
 * @property {number} magic
 * @property {number} encodingVersion
 * @property {number} maxAreas
 * @property {number} playerCount
 * @property {number} numEdges
 * @property {number} activePlayerId
 * @property {number} turnNumber
 * @property {number} terminal
 * @property {number} winner
 * @property {number} won
 * @property {number} truncated
 * @property {number} placement
 * @property {number[][]} nodes      - [maxAreas][NODE_FEATURES.length]
 * @property {number[][]} players    - [playerCount][PLAYER_FEATURES.length]
 * @property {number[]}   board      - [BOARD_FEATURES.length]
 * @property {number[][]} edges      - [numEdges][EDGE_FEATURES.length]
 * @property {number[][]} edgeIndex  - [numEdges][2]
 */

/**
 * Serialize a frame to its self-describing byte buffer (header + tensor payload).
 * The transport, not this function, adds the outbound u32 length prefix.
 *
 * Validates every tensor's shape against the header dims before writing, so a
 * mis-sized tensor fails loudly here rather than corrupting the wire (which the
 * Python parser would silently mis-`reshape`).
 *
 * @param {ObsFrame} frame
 * @returns {Buffer}
 */
export function serializeObsFrame(frame) {
  const { maxAreas, playerCount, numEdges } = frame;

  assertDim('maxAreas', maxAreas);
  assertDim('playerCount', playerCount);
  assertDim('numEdges', numEdges, /* allowZero */ true);

  assertShape('nodes', frame.nodes, maxAreas, NODE_W);
  assertShape('players', frame.players, playerCount, PLAYER_W);
  if (frame.board.length !== BOARD_W) {
    throw new Error(`serializeObsFrame: board width ${frame.board.length} ≠ ${BOARD_W}.`);
  }
  assertShape('edges', frame.edges, numEdges, EDGE_W);
  assertShape('edgeIndex', frame.edgeIndex, numEdges, 2);

  const floatCount = maxAreas * NODE_W + playerCount * PLAYER_W + BOARD_W + numEdges * EDGE_W;
  const intCount = numEdges * 2;
  const totalBytes = HEADER_BYTES + floatCount * 4 + intCount * 4;

  const buf = Buffer.allocUnsafe(totalBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Header
  view.setInt32(0, frame.magic, true);
  view.setInt32(4, frame.encodingVersion, true);
  view.setInt32(8, maxAreas, true);
  view.setInt32(12, playerCount, true);
  view.setInt32(16, numEdges, true);
  view.setInt32(20, frame.activePlayerId, true);
  view.setInt32(24, frame.turnNumber, true);
  view.setInt32(28, frame.terminal, true);
  view.setInt32(32, frame.winner, true);
  view.setInt32(36, frame.won, true);
  view.setInt32(40, frame.truncated, true);
  view.setFloat32(44, frame.placement, true);

  let off = HEADER_BYTES;
  off = writeFloatRows(view, off, frame.nodes);
  off = writeFloatRows(view, off, frame.players);
  off = writeFloatVec(view, off, frame.board);
  off = writeFloatRows(view, off, frame.edges);
  off = writeIntRows(view, off, frame.edgeIndex);

  // Defensive: every declared byte must be written exactly once.
  if (off !== totalBytes) {
    throw new Error(`serializeObsFrame: wrote ${off} bytes, expected ${totalBytes} — layout bug.`);
  }
  return buf;
}

/**
 * Parse a frame buffer back into the structured {@link ObsFrame}. Mirrors the
 * Python parser's job — used by the round-trip parity test and by JS clients.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} input
 * @returns {ObsFrame}
 */
export function parseObsFrame(input) {
  const buf = toBuffer(input);
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`parseObsFrame: ${buf.byteLength} bytes < ${HEADER_BYTES}-byte header.`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const magic = view.getInt32(0, true);
  if (magic !== OBS_FRAME_MAGIC) {
    throw new Error(
      `parseObsFrame: bad magic 0x${(magic >>> 0).toString(16)} (expected ` +
        `0x${OBS_FRAME_MAGIC.toString(16)}) — not a DWOB frame or wrong endianness.`
    );
  }
  const encodingVersion = view.getInt32(4, true);
  const maxAreas = view.getInt32(8, true);
  const playerCount = view.getInt32(12, true);
  const numEdges = view.getInt32(16, true);
  const activePlayerId = view.getInt32(20, true);
  const turnNumber = view.getInt32(24, true);
  const terminal = view.getInt32(28, true);
  const winner = view.getInt32(32, true);
  const won = view.getInt32(36, true);
  const truncated = view.getInt32(40, true);
  const placement = view.getFloat32(44, true);

  const floatCount = maxAreas * NODE_W + playerCount * PLAYER_W + BOARD_W + numEdges * EDGE_W;
  const intCount = numEdges * 2;
  const expectedBytes = HEADER_BYTES + floatCount * 4 + intCount * 4;
  if (buf.byteLength !== expectedBytes) {
    throw new Error(
      `parseObsFrame: ${buf.byteLength} bytes ≠ expected ${expectedBytes} for ` +
        `maxAreas=${maxAreas} playerCount=${playerCount} numEdges=${numEdges}.`
    );
  }

  let off = HEADER_BYTES;
  const nodes = readFloatRows(view, off, maxAreas, NODE_W);
  off += maxAreas * NODE_W * 4;
  const players = readFloatRows(view, off, playerCount, PLAYER_W);
  off += playerCount * PLAYER_W * 4;
  const board = readFloatVec(view, off, BOARD_W);
  off += BOARD_W * 4;
  const edges = readFloatRows(view, off, numEdges, EDGE_W);
  off += numEdges * EDGE_W * 4;
  const edgeIndex = readIntRows(view, off, numEdges, 2);

  return {
    magic,
    encodingVersion,
    maxAreas,
    playerCount,
    numEdges,
    activePlayerId,
    turnNumber,
    terminal,
    winner,
    won,
    truncated,
    placement,
    nodes,
    players,
    board,
    edges,
    edgeIndex,
  };
}

// --- helpers ---

function assertDim(name, v, allowZero = false) {
  if (!Number.isInteger(v) || v < 0 || (!allowZero && v === 0)) {
    throw new Error(
      `serializeObsFrame: ${name}=${v} must be a ${allowZero ? 'non-negative' : 'positive'} integer.`
    );
  }
}

function assertShape(name, rows, height, width) {
  if (rows.length !== height) {
    throw new Error(`serializeObsFrame: ${name} height ${rows.length} ≠ ${height}.`);
  }
  if (height > 0 && rows[0].length !== width) {
    throw new Error(`serializeObsFrame: ${name} width ${rows[0].length} ≠ ${width}.`);
  }
}

function writeFloatRows(view, off, rows) {
  for (const row of rows) {
    for (const v of row) {
      view.setFloat32(off, v, true);
      off += 4;
    }
  }
  return off;
}

function writeFloatVec(view, off, vec) {
  for (const v of vec) {
    view.setFloat32(off, v, true);
    off += 4;
  }
  return off;
}

function writeIntRows(view, off, rows) {
  for (const row of rows) {
    for (const v of row) {
      view.setInt32(off, v, true);
      off += 4;
    }
  }
  return off;
}

function readFloatRows(view, off, height, width) {
  const out = [];
  for (let r = 0; r < height; r++) {
    const row = new Array(width);
    for (let c = 0; c < width; c++) {
      row[c] = view.getFloat32(off, true);
      off += 4;
    }
    out.push(row);
  }
  return out;
}

function readFloatVec(view, off, width) {
  const out = new Array(width);
  for (let c = 0; c < width; c++) {
    out[c] = view.getFloat32(off, true);
    off += 4;
  }
  return out;
}

function readIntRows(view, off, height, width) {
  const out = [];
  for (let r = 0; r < height; r++) {
    const row = new Array(width);
    for (let c = 0; c < width; c++) {
      row[c] = view.getInt32(off, true);
      off += 4;
    }
    out.push(row);
  }
  return out;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array)
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new Error('parseObsFrame: input must be a Buffer, Uint8Array, or ArrayBuffer.');
}
