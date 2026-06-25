import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { runMatch } from '../../src/arena/matchRunner.js';
import { adaptLegacyBot } from '../../src/arena/legacyBotAdapter.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { getValidMoves, applyAction } from '../../src/engine/StateManager.js';
import { createGame } from '../../src/engine/GameRunner.js';
import {
  STOP,
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
  encodeObservationForInference,
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
    expect(ENCODING_VERSION).toBe(2);
    expect(NODE_FEATURES).toEqual([
      'present',
      'diceNorm',
      'isMine',
      'isEnemy',
      'isBorder',
      'enemyNbrDiceMaxNorm',
      'enemyNbrFrac',
      'degreeNorm',
    ]);
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
    expect(EDGE_FEATURES).toEqual([
      'winProb',
      'atkNorm',
      'defNorm',
      'isStop',
      'tgtRetakeThreatNorm',
      'srcVacateThreatNorm',
      'tgtEnemyNbrFrac',
    ]);
  });

  it('binds ENCODING_VERSION to the on-disk column layout (bump the version if columns change)', () => {
    /*
     * Single assertion tying the tensor layout to its version. If you intentionally
     * change any feature column, BUMP ENCODING_VERSION and update both fields below in
     * the same commit — a silent column change under a stale version would let the
     * Python trainer mis-read an old corpus as the new layout. The runtime
     * assertShapeContract guard catches in-process drift; this guards the contract at CI.
     */
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([NODE_FEATURES, PLAYER_FEATURES, BOARD_FEATURES, EDGE_FEATURES]))
      .digest('hex')
      .slice(0, 16);
    expect({ version: ENCODING_VERSION, fingerprint }).toEqual({
      version: 2,
      fingerprint: 'c7637fa6b24540ef',
    });
  });
});

describe('encodeStep — node tensor', () => {
  const enc = encodeStep(syntheticStep(), SYNTH_CTX);

  it('has one row per id in [0, maxAreas)', () => {
    expect(enc.nodes).toHaveLength(6);
    enc.nodes.forEach(row => expect(row).toHaveLength(NODE_FEATURES.length));
  });

  it('zeroes the sentinel (id 0) and absent ids', () => {
    expect(enc.nodes[0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(enc.nodes[5]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('encodes mine/enemy/border relationally with dice/MAX_DICE', () => {
    /*
     * v2 appends [enemyNbrDiceMaxNorm, enemyNbrFrac, degreeNorm], all relational to me=p0.
     * id 1 (mine, nbrs 2[enemy,2 dice] & 3[mine]): enemyDiceMax 2/8, enemyFrac 1/2, degree 2/8.
     * id 2 (enemy, nbr 1[mine]): no enemy-of-p0 neighbour → 0, 0; degree 1/8.
     * id 3 (mine, nbr 1[mine]): 0, 0; degree 1/8.
     * id 4 (enemy, nbr 2[enemy,2 dice]): enemyDiceMax 2/8, enemyFrac 1; degree 1/8.
     */
    expect(enc.nodes[1]).toEqual([1, 3 / 8, 1, 0, 1, 2 / 8, 1 / 2, 2 / 8]);
    expect(enc.nodes[2]).toEqual([1, 2 / 8, 0, 1, 1, 0, 0, 1 / 8]);
    expect(enc.nodes[3]).toEqual([1, 1 / 8, 1, 0, 0, 0, 0, 1 / 8]);
    expect(enc.nodes[4]).toEqual([1, 5 / 8, 0, 1, 1, 2 / 8, 1, 1 / 8]);
  });

  it('throws when an area id falls outside the node range [0, maxAreas)', () => {
    /*
     * An id >= maxAreas (config.maxAreas too small for this board) must fail loud,
     * not silently overflow the fixed-width node tensor.
     */
    const over = syntheticStep();
    over.observation.allAreas.push({ id: 99, owner: 0, dice: 1, neighbors: [], isBorder: false });
    expect(() => encodeStep(over, SYNTH_CTX)).toThrow(/area id 99 out of node range/);

    // A negative id is equally out of range.
    const under = syntheticStep();
    under.observation.allAreas.push({ id: -1, owner: 0, dice: 1, neighbors: [], isBorder: false });
    expect(() => encodeStep(under, SYNTH_CTX)).toThrow(/out of node range/);
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

  it('throws when the acting seat is absent from the players list', () => {
    const step = syntheticStep();
    step.playerId = 99; // a seat with no entry in obs.players
    expect(() => encodeStep(step, SYNTH_CTX)).toThrow(/acting seat 99 is not among/);
  });

  it('throws on an unknown gamePhase instead of silently bucketing it as mid', () => {
    const step = syntheticStep();
    step.observation.gamePhase = 'twilight';
    expect(() => encodeStep(step, SYNTH_CTX)).toThrow(/unknown gamePhase "twilight"/);
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
    expect(enc.edges[0][3]).toBe(0); // isStop (still column 3 in v2)
    expect(enc.edgeIndex[0]).toEqual([1, 2]);
    // STOP edge: zero features, isStop flag (col 3), sentinel gather index
    expect(enc.edges[1]).toEqual([0, 0, 0, 1, 0, 0, 0]);
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

describe('encodeStep — v2 attack-consequence edge features', () => {
  /*
   * A board where the consequence features are all non-zero (the simpler syntheticStep
   * zeroes them). me=p0 attacks 1→2; both endpoints have an OTHER enemy neighbour:
   *   id 1 (me, dice 4) ── nbrs 2 (enemy) & 3 (enemy p2, dice 5)
   *   id 2 (enemy, dice 2) ── nbrs 1 & 4 (enemy p1, dice 6)
   * For 1→2:  tgtRetake = max enemy dice adj to `2` excl. `1` = id4's 6 → 6/8.
   *           srcVacate = max enemy dice adj to `1` excl. `2` = id3's 5 → 5/8.
   *           tgtEnemyNbrFrac = enemy nbrs of `2` excl. `1` (just id4) / 1 = 1.
   */
  function consequenceStep() {
    const allAreas = [
      { id: 1, owner: 0, dice: 4, neighbors: [2, 3], isBorder: true },
      { id: 2, owner: 1, dice: 2, neighbors: [1, 4], isBorder: true },
      { id: 3, owner: 2, dice: 5, neighbors: [1], isBorder: true },
      { id: 4, owner: 1, dice: 6, neighbors: [2], isBorder: true },
    ];
    const players = [0, 1, 2].map(id => ({
      id,
      territories: 1,
      totalDice: 4,
      connectedTerritories: 1,
      reinforcements: 0,
      eliminated: false,
    }));
    return {
      playerId: 0,
      turnNumber: 3,
      observation: {
        myPlayer: 0,
        turnNumber: 3,
        totalPlayers: 3,
        activePlayers: 3,
        gamePhase: 'mid',
        myAreas: allAreas.filter(a => a.owner === 0),
        allAreas,
        players,
      },
      legalMoves: [{ from: 1, to: 2, attackerDice: 4, defenderDice: 2 }, STOP],
      chosenMove: { from: 1, to: 2 },
      outcome: { won: true },
    };
  }

  it('encodes post-capture retaliation, vacated-source exposure, and target surround', () => {
    const enc = encodeStep(consequenceStep(), { ...SYNTH_CTX, playerCount: 3 });
    const attack = enc.edges[0];
    expect(attack[1]).toBe(4 / 8); // atkNorm
    expect(attack[2]).toBe(2 / 8); // defNorm
    expect(attack[3]).toBe(0); // isStop
    expect(attack[4]).toBe(6 / 8); // tgtRetakeThreatNorm — id4 (6 dice) can retake `2`
    expect(attack[5]).toBe(5 / 8); // srcVacateThreatNorm — id3 (5 dice) threatens the emptied `1`
    expect(attack[6]).toBe(1); // tgtEnemyNbrFrac — `2`'s only other neighbour (id4) is enemy
    // node neighbour features are non-zero here too (id1 sees enemy nbrs 2 & 3)
    expect(enc.nodes[1][5]).toBe(5 / 8); // enemyNbrDiceMaxNorm — max(id2=2, id3=5) = 5
    expect(enc.nodes[1][6]).toBe(1); // enemyNbrFrac — both neighbours (2,3) are enemy
    expect(enc.nodes[1][7]).toBe(2 / 8); // degreeNorm — 2 neighbours
  });
});

describe('encodeStep ↔ encodeObservationForInference — cross-path feature parity', () => {
  /*
   * The single most load-bearing invariant the v2 encoder rests on: the train path
   * (encodeStep) and the inference path (encodeObservationForInference) must produce
   * byte-identical node/global/edge features for the same board — the deployed BC bot is
   * trained through the former and runs the latter. Both delegate to the shared
   * neighborStats/attackEdgeFeatures primitives, so they agree today; this pins it so a
   * future edit to one call site (a different `exceptId`, a reverted inline row, a changed
   * `me` argument) can't silently desync the two and feed the net mis-columned tensors.
   *
   * Board (me=p0): id1 (mine, dice 4) attacks enemies id2 & id3. legalMoves below is the
   * COMPLETE legal set (= getValidMoves) so the two paths' attack sets match exactly and
   * every edge is comparable. The 1→3 edge also drives the zero-degree consequence guard
   * (id3's only neighbour is the excluded `from`) on both paths.
   */
  function parityStep() {
    const allAreas = [
      { id: 1, owner: 0, dice: 4, neighbors: [2, 3], isBorder: true },
      { id: 2, owner: 1, dice: 2, neighbors: [1, 4], isBorder: true },
      { id: 3, owner: 2, dice: 5, neighbors: [1], isBorder: true },
      { id: 4, owner: 1, dice: 6, neighbors: [2], isBorder: true },
    ];
    const players = [0, 1, 2].map(id => ({
      id,
      territories: 1,
      totalDice: 4,
      connectedTerritories: 1,
      reinforcements: 0,
      eliminated: false,
    }));
    const observation = {
      myPlayer: 0,
      turnNumber: 3,
      totalPlayers: 3,
      activePlayers: 3,
      gamePhase: 'mid',
      myAreas: allAreas.filter(a => a.owner === 0),
      allAreas,
      players,
    };
    return {
      playerId: 0,
      turnNumber: 3,
      observation,
      legalMoves: [
        { from: 1, to: 2, attackerDice: 4, defenderDice: 2 },
        { from: 1, to: 3, attackerDice: 4, defenderDice: 5 },
        STOP,
      ],
      chosenMove: { from: 1, to: 2 },
      outcome: { won: true },
    };
  }

  const PARITY_CTX = { ...SYNTH_CTX, playerCount: 3 };
  const train = encodeStep(parityStep(), PARITY_CTX);
  // Inference takes the live BotState (= the step's observation; myPlayer === playerId here).
  const infer = encodeObservationForInference(parityStep().observation, {
    maxAreas: PARITY_CTX.maxAreas,
  });

  it('produces identical node, player, and board tensors on both paths', () => {
    expect(infer.nodes).toEqual(train.nodes);
    expect(infer.players).toEqual(train.players);
    expect(infer.board).toEqual(train.board);
  });

  it('produces identical edge features for every attack (matched by from→to)', () => {
    // Map "from->to" → edge row for the attack (non-STOP) edges of each path.
    const attackRows = (edges, edgeIndex) => {
      const m = new Map();
      edges.forEach((row, k) => {
        if (row[3] === 1) return; // skip STOP (isStop col 3)
        m.set(`${edgeIndex[k][0]}->${edgeIndex[k][1]}`, row);
      });
      return m;
    };
    const trainRows = attackRows(train.edges, train.edgeIndex);
    const inferRows = attackRows(infer.edges, infer.edgeIndex);

    // Same attack set (legalMoves is the full getValidMoves set) and identical rows.
    expect([...inferRows.keys()].sort()).toEqual([...trainRows.keys()].sort());
    for (const [key, trainRow] of trainRows) {
      expect(inferRows.get(key)).toEqual(trainRow);
    }

    // The 1→3 edge exercises the zero-degree consequence guard the same way on both paths.
    expect(inferRows.get('1->3')[4]).toBe(0); // tgtRetakeThreatNorm — no other nbr of `3`
    expect(inferRows.get('1->3')[6]).toBe(0); // tgtEnemyNbrFrac — degree-0 guard → 0
  });

  it('appends an identical trailing STOP edge on both paths', () => {
    expect(infer.moves[infer.moves.length - 1]).toBeNull();
    expect(infer.edges[infer.edges.length - 1]).toEqual(train.edges[train.edges.length - 1]);
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
    /*
     * Single forward pass — O(n). trajectoryFromReplay gives every fat step in one
     * pass; we replay the same actions independently to recompute getValidMoves at
     * each decision's pre-action state. (Re-deriving per index via replayToState is
     * O(n²) and times out under CI's coverage instrumentation.)
     */
    const steps = trajectoryFromReplay(record);
    let state = createGame(record.config);
    for (let i = 0; i < steps.length; i++) {
      const action = record.actions[i];
      const validKey = new Set(getValidMoves(state).map(m => `${m.from}->${m.to}`));
      const enc = encodeStep(steps[i], ctx);

      // exactly one STOP edge, always last
      expect(enc.edges.filter(e => e[3] === 1)).toHaveLength(1);
      expect(enc.edges[enc.edges.length - 1][3]).toBe(1);
      expect(enc.mask.every(m => m === 1)).toBe(true);

      // non-STOP edges === getValidMoves, as a set
      const attackKey = new Set(
        enc.edgeIndex.filter((_, k) => enc.edges[k][3] === 0).map(([f, t]) => `${f}->${t}`)
      );
      expect(attackKey).toEqual(validKey);
      expect(enc.edges.length).toBe(validKey.size + 1);

      // the label points at the move actually applied at this step
      if (action.type === 'END_TURN') {
        expect(enc.edges[enc.label][3]).toBe(1);
      } else {
        expect(enc.edgeIndex[enc.label]).toEqual([action.from, action.to]);
      }

      state = applyAction(state, action);
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
