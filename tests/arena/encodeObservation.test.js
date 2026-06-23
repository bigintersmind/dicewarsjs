import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runMatch } from '../../src/arena/matchRunner.js';
import { adaptLegacyBot } from '../../src/arena/legacyBotAdapter.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { getValidMoves } from '../../src/engine/StateManager.js';
import { replayToState } from '../../src/arena/replayFormat.js';
import {
  STOP,
  trajectoryStepFromReplay,
  trajectoryFromReplay,
  serializeTrajectory,
  deserializeTrajectory,
} from '../../src/arena/trajectoryExport.js';
import {
  ENCODING_VERSION,
  NODE_FEATURES,
  PLAYER_FEATURES,
  BOARD_FEATURES,
  EDGE_FEATURES,
  encodeStep,
  teacherSeatsOf,
} from '../../src/arena/encodeObservation.js';

const exampleBot = adaptLegacyBot(ai_example);

/**
 * A hand-built fat step + context with known values, so feature math is asserted
 * against arithmetic, not against whatever a real game happens to produce.
 *
 * Board: ids 1,3 are mine (p0); 2,4 are enemies (p1,p2); ids 0 and 5 are absent.
 * Present-area count = 4 (the territory denominator); total dice in play = 11.
 */
function syntheticStep({ chosenMove } = {}) {
  const allAreas = [
    { id: 1, owner: 0, dice: 3, neighbors: [2, 3], isBorder: true },
    { id: 2, owner: 1, dice: 2, neighbors: [1], isBorder: true },
    { id: 3, owner: 0, dice: 1, neighbors: [1], isBorder: false },
    { id: 4, owner: 2, dice: 5, neighbors: [2], isBorder: true },
  ];
  const players = [
    {
      id: 0,
      territories: 2,
      totalDice: 4,
      connectedTerritories: 2,
      reinforcements: 6,
      eliminated: false,
    },
    {
      id: 1,
      territories: 1,
      totalDice: 2,
      connectedTerritories: 1,
      reinforcements: 0,
      eliminated: false,
    },
    {
      id: 2,
      territories: 1,
      totalDice: 5,
      connectedTerritories: 1,
      reinforcements: 64,
      eliminated: false,
    },
  ];
  const observation = {
    myPlayer: 0,
    turnNumber: 7,
    totalPlayers: 3,
    activePlayers: 3,
    gamePhase: 'mid',
    myAreas: allAreas.filter(a => a.owner === 0),
    allAreas,
    players,
  };
  const legalMoves = [{ from: 1, to: 2, attackerDice: 3, defenderDice: 2 }, STOP];
  return {
    playerId: 0,
    turnNumber: 7,
    observation,
    legalMoves,
    chosenMove: chosenMove ?? { from: 1, to: 2 },
    outcome: { won: true },
  };
}

const SYNTH_CTX = { maxAreas: 6, playerCount: 3, winner: 0, placements: [0, 1, 2] };

describe('encodeObservation — feature-name contract', () => {
  it('declares stable column orders and an encoding version', () => {
    expect(ENCODING_VERSION).toBe(1);
    expect(NODE_FEATURES).toEqual(['present', 'diceNorm', 'isMine', 'isEnemy', 'isBorder']);
    expect(PLAYER_FEATURES).toEqual([
      'isMe',
      'eliminated',
      'territoriesFrac',
      'diceFrac',
      'connectedFrac',
      'stockNorm',
    ]);
    expect(BOARD_FEATURES).toEqual([
      'myDiceShare',
      'activeFrac',
      'phaseEarly',
      'phaseMid',
      'phaseLate',
    ]);
    expect(EDGE_FEATURES).toEqual(['winProb', 'atkNorm', 'defNorm', 'isStop']);
  });
});

describe('encodeStep — node tensor', () => {
  const enc = encodeStep(syntheticStep(), SYNTH_CTX);

  it('has one row per id in [0, maxAreas)', () => {
    expect(enc.nodes).toHaveLength(6);
    enc.nodes.forEach(row => expect(row).toHaveLength(NODE_FEATURES.length));
  });

  it('zeroes the sentinel (id 0) and absent ids', () => {
    expect(enc.nodes[0]).toEqual([0, 0, 0, 0, 0]);
    expect(enc.nodes[5]).toEqual([0, 0, 0, 0, 0]);
  });

  it('encodes mine/enemy/border relationally with dice/MAX_DICE', () => {
    // id 1: mine, dice 3, border
    expect(enc.nodes[1]).toEqual([1, 3 / 8, 1, 0, 1]);
    // id 2: enemy, dice 2, border
    expect(enc.nodes[2]).toEqual([1, 2 / 8, 0, 1, 1]);
    // id 3: mine, dice 1, interior
    expect(enc.nodes[3]).toEqual([1, 1 / 8, 1, 0, 0]);
    // id 4: enemy, dice 5, border
    expect(enc.nodes[4]).toEqual([1, 5 / 8, 0, 1, 1]);
  });
});

describe('encodeStep — per-player globals and board scalars', () => {
  const enc = encodeStep(syntheticStep(), SYNTH_CTX);

  it('normalizes per-seat features by board totals, with is_me set only for the actor', () => {
    expect(enc.players).toHaveLength(3);
    // p0 (me): terr 2/4, dice 4/11, group 2/4, stock 6/64
    expect(enc.players[0][0]).toBe(1); // isMe
    expect(enc.players[0][1]).toBe(0); // eliminated
    expect(enc.players[0][2]).toBeCloseTo(2 / 4, 12);
    expect(enc.players[0][3]).toBeCloseTo(4 / 11, 12);
    expect(enc.players[0][4]).toBeCloseTo(2 / 4, 12);
    expect(enc.players[0][5]).toBeCloseTo(6 / 64, 12);
    // p2: isMe 0, dice 5/11, stock fully capped (64/64 = 1)
    expect(enc.players[2][0]).toBe(0);
    expect(enc.players[2][3]).toBeCloseTo(5 / 11, 12);
    expect(enc.players[2][5]).toBe(1);
  });

  it('encodes board scalars with a one-hot game phase', () => {
    expect(enc.board).toHaveLength(BOARD_FEATURES.length);
    expect(enc.board[0]).toBeCloseTo(4 / 11, 12); // my dice share
    expect(enc.board[1]).toBeCloseTo(3 / 3, 12); // active fraction
    expect(enc.board.slice(2)).toEqual([0, 1, 0]); // phase = mid
  });
});

describe('encodeStep — action head, label, and value', () => {
  it('builds one edge per legal move plus STOP, masked all-ones', () => {
    const enc = encodeStep(syntheticStep(), SYNTH_CTX);
    expect(enc.edges).toHaveLength(2);
    expect(enc.mask).toEqual([1, 1]);
    // attack 3 vs 2: winProb in (0,1), atk 3/8, def 2/8, not STOP
    expect(enc.edges[0][0]).toBeGreaterThan(0);
    expect(enc.edges[0][0]).toBeLessThan(1);
    expect(enc.edges[0][1]).toBe(3 / 8);
    expect(enc.edges[0][2]).toBe(2 / 8);
    expect(enc.edges[0][3]).toBe(0);
    expect(enc.edgeIndex[0]).toEqual([1, 2]);
    // STOP edge: zero features, isStop flag, sentinel gather index
    expect(enc.edges[1]).toEqual([0, 0, 0, 1]);
    expect(enc.edgeIndex[1]).toEqual([0, 0]);
  });

  it('labels the chosen attack edge', () => {
    const enc = encodeStep(syntheticStep({ chosenMove: { from: 1, to: 2 } }), SYNTH_CTX);
    expect(enc.label).toBe(0);
  });

  it('labels STOP when the teacher ended its turn', () => {
    const enc = encodeStep(syntheticStep({ chosenMove: STOP }), SYNTH_CTX);
    expect(enc.label).toBe(1);
  });

  it('throws when the chosen move is not in the legal set (poisoned label)', () => {
    const step = syntheticStep({ chosenMove: { from: 3, to: 4 } });
    expect(() => encodeStep(step, SYNTH_CTX)).toThrow(/not found in legalMoves/);
  });

  it('maps placement to a normalized value-head target (1 = first … 0 = last)', () => {
    const first = encodeStep(syntheticStep(), { ...SYNTH_CTX, winner: 0, placements: [0, 1, 2] });
    expect(first.value).toEqual({ won: 1, placement: 1 });

    const last = encodeStep(syntheticStep(), { ...SYNTH_CTX, winner: 1, placements: [1, 2, 0] });
    expect(last.value.won).toBe(0);
    expect(last.value.placement).toBeCloseTo(0, 12); // rank 2 of 3 → 1 - 2/2 = 0

    const middle = encodeStep(syntheticStep(), { ...SYNTH_CTX, winner: 1, placements: [1, 0, 2] });
    expect(middle.value.placement).toBeCloseTo(0.5, 12); // rank 1 of 3 → 1 - 1/2
  });

  it('rejects a step whose player count disagrees with the context', () => {
    expect(() => encodeStep(syntheticStep(), { ...SYNTH_CTX, playerCount: 4 })).toThrow(
      /players but ctx.playerCount/
    );
  });
});

describe('teacherSeatsOf', () => {
  it('matches seats by base bot name, stripping the #n duplicate-seat suffix', () => {
    const record = {
      metadata: { bots: ['Lookahead#1', 'Strategist', 'Lookahead#2', 'Defensive'] },
    };
    expect(teacherSeatsOf(record, 'Lookahead')).toEqual([0, 2]);
    expect(teacherSeatsOf(record, 'Strategist')).toEqual([1]);
    expect(teacherSeatsOf(record, 'Expectimax')).toEqual([]);
  });

  it('matches an unsuffixed single seat', () => {
    const record = { metadata: { bots: ['Lookahead', 'Strategist'] } };
    expect(teacherSeatsOf(record, 'Lookahead')).toEqual([0]);
  });
});

describe('encodeStep — action mask matches getValidMoves (the encoding invariant)', () => {
  /*
   * Re-derive a real game, then independently recompute getValidMoves on each
   * decision's state and assert the encoder's non-STOP edges are exactly that set.
   */
  const bots = [
    { name: 'a', fn: exampleBot },
    { name: 'b', fn: exampleBot },
    { name: 'c', fn: exampleBot },
    { name: 'd', fn: exampleBot },
  ];
  const result = runMatch({ bots, seed: 42, recordHistory: false, recordTrajectory: true });
  const record = result.trajectory;
  const ctx = {
    maxAreas: record.config.maxAreas,
    playerCount: record.config.playerCount,
    winner: record.metadata.winner,
    placements: record.metadata.placements,
  };

  it('produces a non-trivial trajectory to check', () => {
    expect(record.actions.length).toBeGreaterThan(10);
  });

  it('encodes exactly getValidMoves(state) + STOP at every decision, with the label on the applied move', () => {
    for (let i = 0; i < record.actions.length; i++) {
      const state = replayToState(record, i);
      const validKey = new Set(getValidMoves(state).map(m => `${m.from}->${m.to}`));

      const step = trajectoryStepFromReplay(record, i);
      const enc = encodeStep(step, ctx);

      // exactly one STOP edge, always last
      const stopRows = enc.edges.filter(e => e[3] === 1);
      expect(stopRows).toHaveLength(1);
      expect(enc.edges[enc.edges.length - 1][3]).toBe(1);
      expect(enc.mask.every(m => m === 1)).toBe(true);

      // non-STOP edges === getValidMoves, as a set
      const attackKey = new Set(
        enc.edgeIndex.filter((_, k) => enc.edges[k][3] === 0).map(([f, t]) => `${f}->${t}`)
      );
      expect(attackKey).toEqual(validKey);
      expect(enc.edges.length).toBe(validKey.size + 1);

      // the label points at the move actually applied at this step
      const action = record.actions[i];
      if (action.type === 'END_TURN') {
        expect(enc.edges[enc.label][3]).toBe(1);
      } else {
        expect(enc.edgeIndex[enc.label]).toEqual([action.from, action.to]);
      }
    }
  });

  it('survives the JSONL serialize → deserialize round-trip', () => {
    const reloaded = deserializeTrajectory(serializeTrajectory(record));
    const steps = trajectoryFromReplay(reloaded);
    const ctx2 = {
      maxAreas: reloaded.config.maxAreas,
      playerCount: reloaded.config.playerCount,
      winner: reloaded.metadata.winner,
      placements: reloaded.metadata.placements,
    };
    const enc = encodeStep(steps[0], ctx2);
    expect(enc.nodes).toHaveLength(reloaded.config.maxAreas);
    expect(enc.players).toHaveLength(reloaded.config.playerCount);
    expect(enc.label).toBeGreaterThanOrEqual(0);
    expect(enc.label).toBeLessThan(enc.edges.length);
  });
});

describe('encodeStep — e2e over the corpus sample (if present)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpus = resolve(here, '../../data/selfplay/corpus-fullfield-300.jsonl');
  const maybe = existsSync(corpus) ? it : it.skip;

  maybe('encodes Lookahead-seat steps from real 7-player games', () => {
    const lines = readFileSync(corpus, 'utf8').trim().split('\n').slice(0, 5);
    let encoded = 0;
    for (const line of lines) {
      const record = deserializeTrajectory(line);
      const seats = teacherSeatsOf(record, 'Lookahead');
      expect(seats.length).toBeGreaterThan(0);
      const ctx = {
        maxAreas: record.config.maxAreas,
        playerCount: record.config.playerCount,
        winner: record.metadata.winner,
        placements: record.metadata.placements,
      };
      for (const step of trajectoryFromReplay(record)) {
        if (!seats.includes(step.playerId)) continue;
        const enc = encodeStep(step, ctx);
        encoded++;
        expect(enc.nodes).toHaveLength(record.config.maxAreas);
        expect(enc.players).toHaveLength(record.config.playerCount);
        expect(enc.label).toBeGreaterThanOrEqual(0);
        expect(enc.label).toBeLessThan(enc.edges.length);
        expect(enc.value.placement).toBeGreaterThanOrEqual(0);
        expect(enc.value.placement).toBeLessThanOrEqual(1);
      }
    }
    expect(encoded).toBeGreaterThan(0);
  });
});
