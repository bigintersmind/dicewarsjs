/**
 * Cross-bridge action-encoding parity (ml-bot Phase 3 — [D-19], tracer step 2).
 *
 * The PPO bridge sends the learner an observation whose action head is a list of
 * edges; the learner replies with an integer index; the env maps that index back to
 * a concrete `{from,to}` attack (or STOP). The entire correctness of self-play rests
 * on that index meaning the SAME move on both sides. This suite pins it:
 *
 *   - the encoder's three parallel arrays (`moves`/`edgeIndex`/`edges`) are index-aligned;
 *   - STOP is always the unique, last slot;
 *   - the attack ordering coincides with `getValidMoves` (today an emergent coincidence,
 *     not an enforced invariant — so this is the guard that makes a future reorder LOUD);
 *   - the env's `decodeAction` is the SAME mapping the shipped BC bot uses;
 *   - the binary frame round-trips byte-for-byte.
 *
 * The action source is ALWAYS the encoder's own `moves[]` — never a fresh
 * `getValidMoves` (the test asserts they agree, but the bridge must not depend on it).
 *
 * Must be green before any PPO training.
 */

import { createGame } from '../../src/engine/GameRunner.js';
import { getValidMoves } from '../../src/engine/StateManager.js';
import { createBotState } from '../../src/arena/botState.js';
import {
  encodeObservationForInference,
  ENCODING_VERSION,
} from '../../src/arena/encodeObservation.js';
import { argmax, forward } from '../../src/ai/bcForward.js';
import { BC_POLICY } from '../../src/ai/bcPolicyWeights.js';
import { ai_bc } from '../../src/ai/ai_bc.js';

import { decodeAction } from '../../scripts/lib/ppo-env.mjs';
import {
  buildObsFrame,
  serializeObsFrame,
  parseObsFrame,
  OBS_FRAME_MAGIC,
} from '../../scripts/lib/obs-frame.mjs';

const PLAYER_COUNT = 7;
const STOP_EDGE_ROW = [0, 0, 0, 1, 0, 0, 0]; // EDGE_FEATURES with isStop (col 3) = 1
const f32 = x => Math.fround(x);

/** First seed whose acting seat has at least `minAttacks` legal attacks. */
function findRealState(minAttacks, { seedStart = 1, seedEnd = 600 } = {}) {
  for (let seed = seedStart; seed <= seedEnd; seed++) {
    const state = createGame({ seed, playerCount: PLAYER_COUNT, recordHistory: false });
    const active = state.turnOrder[state.currentPlayerIndex];
    const moves = getValidMoves(state);
    if (moves.length >= minAttacks) {
      const botState = createBotState(state, active);
      const maxAreas = state.areas.length;
      return { seed, state, active, moves, botState, maxAreas };
    }
  }
  throw new Error(`No state with >= ${minAttacks} attacks in seeds ${seedStart}..${seedEnd}.`);
}

/**
 * Build a field-accurate synthetic BotState (the exact shape `createBotState` emits)
 * for the edge cases that are awkward to reach from a fresh game.
 */
function makeBotState({ myPlayer, areas, players, gamePhase = 'mid', turnNumber = 5 }) {
  const byId = new Map(areas.map(a => [a.id, a]));
  const allAreas = areas.map(a =>
    Object.freeze({
      id: a.id,
      owner: a.owner,
      dice: a.dice,
      neighbors: Object.freeze([...a.neighbors]),
      isBorder:
        a.isBorder ?? a.neighbors.some(nId => byId.has(nId) && byId.get(nId).owner !== a.owner),
    })
  );
  const botPlayers = players.map(p =>
    Object.freeze({
      id: p.id,
      territories: p.territories ?? 0,
      totalDice: p.totalDice ?? 0,
      connectedTerritories: p.connectedTerritories ?? 0,
      reinforcements: p.reinforcements ?? 0,
      eliminated: p.eliminated ?? false,
    })
  );
  return Object.freeze({
    myPlayer,
    turnNumber,
    totalPlayers: botPlayers.length,
    activePlayers: botPlayers.filter(p => !p.eliminated).length,
    gamePhase,
    myAreas: Object.freeze(allAreas.filter(a => a.owner === myPlayer)),
    allAreas: Object.freeze(allAreas),
    players: Object.freeze(botPlayers),
  });
}

describe('PPO action-encoding parity (encoder index ↔ move)', () => {
  it('the three parallel arrays are index-aligned (moves ↔ edgeIndex)', () => {
    const { botState, maxAreas } = findRealState(4);
    const enc = encodeObservationForInference(botState, { maxAreas });
    expect(enc.moves.length).toBe(enc.edgeIndex.length);
    expect(enc.moves.length).toBe(enc.edges.length);
    for (let i = 0; i < enc.moves.length; i++) {
      const expectedIdx = enc.moves[i] === null ? [0, 0] : [enc.moves[i].from, enc.moves[i].to];
      expect(enc.edgeIndex[i]).toEqual(expectedIdx);
    }
  });

  it('STOP is the unique, last slot', () => {
    const { botState, maxAreas } = findRealState(4);
    const enc = encodeObservationForInference(botState, { maxAreas });
    const n = enc.moves.length;
    expect(enc.moves[n - 1]).toBeNull();
    expect(enc.edgeIndex[n - 1]).toEqual([0, 0]);
    expect(enc.edges[n - 1]).toEqual(STOP_EDGE_ROW);
    // No other slot is STOP / [0,0].
    for (let i = 0; i < n - 1; i++) {
      expect(enc.moves[i]).not.toBeNull();
      expect(enc.edgeIndex[i]).not.toEqual([0, 0]);
      expect(enc.edges[i][3]).toBe(0); // isStop column
    }
  });

  it('multi-edge ordering: decoded moves are legal AND in getValidMoves order', () => {
    const { botState, moves: validMoves, maxAreas } = findRealState(4);
    const enc = encodeObservationForInference(botState, { maxAreas });
    const attackCount = enc.moves.length - 1;
    expect(attackCount).toBeGreaterThanOrEqual(4); // an ordering bug must be observable

    // Membership: every decoded index round-trips to a legal move.
    const legalSet = new Set(validMoves.map(m => `${m.from}->${m.to}`));
    for (let i = 0; i < attackCount; i++) {
      const move = decodeAction(enc, i);
      expect(move).not.toBeNull();
      expect(legalSet.has(`${move.from}->${move.to}`)).toBe(true);
    }
    // Order: the attack subsequence equals getValidMoves element-by-element.
    const fromEncoder = enc.moves.slice(0, attackCount).map(m => ({ from: m.from, to: m.to }));
    const fromEngine = validMoves.map(m => ({ from: m.from, to: m.to }));
    expect(fromEncoder).toEqual(fromEngine);
  });

  it('divergence guard: botState ids/neighbors preserve the order the encoder relies on', () => {
    const { state, botState } = findRealState(4);
    // allAreas ids are strictly ascending and equal the present-area ids of state.areas.
    const ids = botState.allAreas.map(a => a.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    const presentIds = [];
    for (let i = 1; i < state.areas.length; i++) {
      if (state.areas[i].size > 0) presentIds.push(state.areas[i].id);
    }
    expect(ids).toEqual(presentIds);
    // Each area's neighbor order equals state's neighborAreaIds filtered (present, in range).
    for (const area of botState.allAreas) {
      const engineNbrs = state.areas[area.id].neighborAreaIds.filter(
        adj => adj > 0 && adj < state.areas.length && state.areas[adj].size > 0
      );
      expect([...area.neighbors]).toEqual(engineNbrs);
    }
  });

  it('decodeAction rejects an out-of-range index loudly (desync, not a move)', () => {
    const { botState, maxAreas } = findRealState(4);
    const enc = encodeObservationForInference(botState, { maxAreas });
    const n = enc.moves.length;
    expect(() => decodeAction(enc, -1)).toThrow(/out of range/);
    expect(() => decodeAction(enc, n)).toThrow(/out of range/);
    expect(() => decodeAction(enc, 1.5)).toThrow(/out of range/);
  });

  it('decodeAction rejects an encoded whose trailing edge is not STOP (encoder layout drift)', () => {
    /*
     * Hand-built encoders whose last slot is an attack (not null) must trip the invariant guard,
     * rather than silently decode an index against a STOP-less array.
     */
    const noStop = { moves: [{ from: 1, to: 2 }] };
    expect(() => decodeAction(noStop, 0)).toThrow(/trailing edge is not STOP/);
    const twoAttacks = { moves: [{ from: 1, to: 2 }, { from: 3, to: 4 }] };
    expect(() => decodeAction(twoAttacks, 1)).toThrow(/trailing edge is not STOP/);
  });

  it('zero-valid-moves seat: STOP-only action space (N === 1)', () => {
    // Acting seat owns only 1-die areas → no legal attack → just STOP.
    const botState = makeBotState({
      myPlayer: 0,
      areas: [
        { id: 1, owner: 0, dice: 1, neighbors: [2, 3] },
        { id: 2, owner: 0, dice: 1, neighbors: [1, 3] },
        { id: 3, owner: 0, dice: 1, neighbors: [1, 2] },
      ],
      players: [
        { id: 0, territories: 3, totalDice: 3, connectedTerritories: 3 },
        { id: 1, territories: 5, totalDice: 9, connectedTerritories: 5 },
      ],
    });
    const enc = encodeObservationForInference(botState, { maxAreas: 8 });
    expect(enc.moves).toEqual([null]);
    expect(enc.edgeIndex).toEqual([[0, 0]]);
    expect(enc.edges).toEqual([STOP_EDGE_ROW]);
    expect(decodeAction(enc, 0)).toBeNull(); // only legal index → STOP
    expect(() => decodeAction(enc, 1)).toThrow(/out of range/);
  });

  it('eliminated opponent: no edge targets a dead seat; players tensor keeps full width', () => {
    // Seat 0 can attack seat 1 (alive); seat 2 is eliminated (no territories).
    const botState = makeBotState({
      myPlayer: 0,
      areas: [
        { id: 1, owner: 0, dice: 3, neighbors: [2] },
        { id: 2, owner: 1, dice: 1, neighbors: [1] },
      ],
      players: [
        { id: 0, territories: 1, totalDice: 3, connectedTerritories: 1 },
        { id: 1, territories: 1, totalDice: 1, connectedTerritories: 1 },
        { id: 2, territories: 0, totalDice: 0, connectedTerritories: 0, eliminated: true },
      ],
    });
    const enc = encodeObservationForInference(botState, { maxAreas: 8 });
    // One attack (1->2 owned by seat 1) + STOP.
    expect(enc.moves).toEqual([{ from: 1, to: 2 }, null]);
    // No edge targets an area owned by an eliminated seat (seat 2 owns none).
    const eliminatedAreaIds = new Set(
      botState.allAreas.filter(a => botState.players[a.owner]?.eliminated).map(a => a.id)
    );
    for (const move of enc.moves) {
      if (move) expect(eliminatedAreaIds.has(move.to)).toBe(false);
    }
    // Players tensor keeps full width and marks the eliminated seat.
    expect(enc.players.length).toBe(3);
    expect(enc.players[2][1]).toBe(1); // 'eliminated' column
    expect(enc.players[0][0]).toBe(1); // 'isMe' column for seat 0
  });
});

describe('PPO bridge decode == BC bot decode (cross-path)', () => {
  it('decodeAction(encoded, argmax(logits)) equals ai_bc(botState)', () => {
    const maxAreas = BC_POLICY.config.maxAreas;
    const { state, botState } = findRealState(4);
    // The policy was trained on this board; its node space must cover it.
    expect(state.areas.length).toBeLessThanOrEqual(maxAreas);
    expect(BC_POLICY.encodingVersion).toBe(ENCODING_VERSION);

    const enc = encodeObservationForInference(botState, { maxAreas });
    const { logits } = forward(BC_POLICY, enc);
    const idx = argmax(logits);

    const bridgeMove = decodeAction(enc, idx);
    const bcMove = ai_bc(botState);
    expect(bridgeMove).toEqual(bcMove);
  });
});

describe('PPO obs-frame binary round-trip', () => {
  it('serialize → parse preserves header, ints exactly, floats at f32', () => {
    const { botState, maxAreas } = findRealState(4);
    const enc = encodeObservationForInference(botState, { maxAreas });
    const frame = buildObsFrame({
      encoded: enc,
      botState,
      maxAreas,
      terminal: 1,
      winner: 3,
      won: 1,
      /*
       * truncated rides as an i32 at offset 40 (between won@36 and placement@44). A non-zero
       * value is load-bearing: 0 serializes identically as int or float, so only a non-zero
       * truncated catches a dtype/offset regression on this slot (it would round-trip as garbage).
       */
      truncated: 1,
      placement: 0.75,
    });
    const parsed = parseObsFrame(serializeObsFrame(frame));

    // Header
    expect(parsed.magic).toBe(OBS_FRAME_MAGIC);
    expect(parsed.encodingVersion).toBe(ENCODING_VERSION);
    expect(parsed.maxAreas).toBe(maxAreas);
    expect(parsed.playerCount).toBe(botState.players.length);
    expect(parsed.numEdges).toBe(enc.moves.length);
    expect(parsed.activePlayerId).toBe(botState.myPlayer);
    expect(parsed.turnNumber).toBe(botState.turnNumber);
    expect(parsed.terminal).toBe(1);
    expect(parsed.winner).toBe(3);
    expect(parsed.won).toBe(1);
    expect(parsed.truncated).toBe(1); // i32 at offset 40 survives the round-trip (not f32-corrupted)
    expect(parsed.placement).toBeCloseTo(0.75, 6);

    // Ints exact; floats round-trip at single precision.
    expect(parsed.edgeIndex).toEqual(enc.edgeIndex);
    expect(parsed.edges).toEqual(enc.edges.map(row => row.map(f32)));
    expect(parsed.nodes).toEqual(enc.nodes.map(row => row.map(f32)));
    expect(parsed.players).toEqual(enc.players.map(row => row.map(f32)));
    expect(parsed.board).toEqual(enc.board.map(f32));

    // STOP row's isStop float survives as exactly 1.0 at the right offset.
    expect(parsed.edges[parsed.numEdges - 1][3]).toBe(1);
  });

  it('re-serialization is byte-idempotent (stable wire encoding)', () => {
    const { botState, maxAreas } = findRealState(4);
    const enc = encodeObservationForInference(botState, { maxAreas });
    const frame = buildObsFrame({ encoded: enc, botState, maxAreas });
    const buf1 = serializeObsFrame(frame);
    const buf2 = serializeObsFrame(parseObsFrame(buf1));
    expect(Buffer.compare(buf1, buf2)).toBe(0);
  });

  it('parse rejects a corrupt magic loudly', () => {
    const { botState, maxAreas } = findRealState(4);
    const enc = encodeObservationForInference(botState, { maxAreas });
    const buf = serializeObsFrame(buildObsFrame({ encoded: enc, botState, maxAreas }));
    buf.writeInt32LE(0xdeadbeef | 0, 0);
    expect(() => parseObsFrame(buf)).toThrow(/bad magic/);
  });
});
