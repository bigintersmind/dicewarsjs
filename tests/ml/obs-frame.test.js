/**
 * PPO obs-frame codec validation (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * The wire codec's whole job is to fail LOUD on a malformed frame rather than let a
 * mis-sized tensor reach the Python parser, which would silently `reshape` garbage. The
 * round-trip happy path is covered in `ppo-action-parity.test.js`; this suite pins the
 * negative space — the shape/dim guards on serialize and the size/type guards on parse —
 * plus the `numEdges = 0` boundary and the non-Buffer input forms `parseObsFrame` accepts.
 */

import {
  ENCODING_VERSION,
  NODE_FEATURES,
  PLAYER_FEATURES,
  BOARD_FEATURES,
  EDGE_FEATURES,
} from '../../src/arena/encodeObservation.js';
import {
  serializeObsFrame,
  parseObsFrame,
  OBS_FRAME_MAGIC,
} from '../../scripts/lib/obs-frame.mjs';

const NODE_W = NODE_FEATURES.length;
const PLAYER_W = PLAYER_FEATURES.length;
const BOARD_W = BOARD_FEATURES.length;
const EDGE_W = EDGE_FEATURES.length;

const zeros = (h, w) => Array.from({ length: h }, () => new Array(w).fill(0));

/** A structurally-valid frame object the serializer accepts (dims/shapes all agree). */
function validFrame({ maxAreas = 4, playerCount = 3, numEdges = 2 } = {}) {
  return {
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
    nodes: zeros(maxAreas, NODE_W),
    players: zeros(playerCount, PLAYER_W),
    board: new Array(BOARD_W).fill(0),
    edges: zeros(numEdges, EDGE_W),
    edgeIndex: zeros(numEdges, 2),
  };
}

describe('serializeObsFrame — shape & dim validation', () => {
  it('round-trips a structurally-valid frame', () => {
    const parsed = parseObsFrame(serializeObsFrame(validFrame()));
    expect(parsed.maxAreas).toBe(4);
    expect(parsed.playerCount).toBe(3);
    expect(parsed.numEdges).toBe(2);
    expect(parsed.edges.length).toBe(2);
  });

  it('rejects maxAreas = 0 (must be a positive integer)', () => {
    const f = validFrame();
    f.maxAreas = 0;
    f.nodes = [];
    expect(() => serializeObsFrame(f)).toThrow(/maxAreas=0 must be a positive integer/);
  });

  it('rejects a nodes tensor whose height ≠ maxAreas', () => {
    const f = validFrame({ maxAreas: 4 });
    f.nodes = zeros(3, NODE_W); // one row short
    expect(() => serializeObsFrame(f)).toThrow(/nodes height 3 ≠ 4/);
  });

  it('rejects an edges tensor of the wrong width (representative first row)', () => {
    const f = validFrame({ numEdges: 2 });
    f.edges = [new Array(EDGE_W + 1).fill(0), new Array(EDGE_W + 1).fill(0)];
    expect(() => serializeObsFrame(f)).toThrow(/edges width/);
  });

  it('rejects a board vector of the wrong width', () => {
    const f = validFrame();
    f.board = new Array(BOARD_W + 2).fill(0);
    expect(() => serializeObsFrame(f)).toThrow(/board width/);
  });

  it('allows numEdges = 0 and round-trips an empty action space', () => {
    const f = validFrame({ numEdges: 0 });
    f.edges = [];
    f.edgeIndex = [];
    const parsed = parseObsFrame(serializeObsFrame(f));
    expect(parsed.numEdges).toBe(0);
    expect(parsed.edges).toEqual([]);
    expect(parsed.edgeIndex).toEqual([]);
  });
});

describe('parseObsFrame — size & type guards', () => {
  it('rejects a buffer smaller than the fixed header', () => {
    expect(() => parseObsFrame(Buffer.alloc(10))).toThrow(/< 48-byte header/);
  });

  it('rejects a buffer whose length disagrees with its header dims', () => {
    const buf = serializeObsFrame(validFrame());
    const tooLong = Buffer.concat([buf, Buffer.from([0])]); // one trailing byte
    expect(() => parseObsFrame(tooLong)).toThrow(/bytes ≠ expected/);
  });

  it('rejects a non-Buffer/Uint8Array/ArrayBuffer input', () => {
    expect(() => parseObsFrame(42)).toThrow(/must be a Buffer, Uint8Array, or ArrayBuffer/);
  });

  it('accepts a Uint8Array view and a bare ArrayBuffer', () => {
    const buf = serializeObsFrame(validFrame());
    const fromU8 = parseObsFrame(new Uint8Array(buf));
    const fromAb = parseObsFrame(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(fromU8.numEdges).toBe(2);
    expect(fromAb.numEdges).toBe(2);
  });
});
