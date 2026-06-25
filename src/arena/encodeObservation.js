/**
 * Observation Encoder — the Phase-2 tensor-expansion pass (docs/ml-bot/).
 *
 * Turns one re-derived fat trajectory step (a {@link import('./trajectoryExport.js').TrajectoryStep})
 * into the fixed-shape numeric tensors the behavioral-cloning net consumes, exactly per the
 * **D-Encoding** contract in `docs/ml-bot/DECISIONS.md`:
 *
 *   - **Nodes** — a graph over the fixed territory-id node space `0 .. maxAreas-1` (id 0 is
 *     the unused sentinel). One row per id; absent ids are zero with `present = 0`. Features
 *     are **relational** (`isMine`/`isEnemy`), never an absolute seat one-hot, so the policy
 *     is seat-symmetric. v2 ([D-17]) adds three local-neighbourhood features (enemy-threat
 *     magnitude, enemy fraction, degree) so the per-node MLP sees board structure.
 *   - **Per-player globals** — one row per seat (`isMe` marks self), the quantities the
 *     teacher's posture/leader terms key off.
 *   - **Board scalars** — my dice-share, active fraction, game-phase one-hot.
 *   - **Action head** — one row per legal move from `getValidMoves` plus an explicit STOP,
 *     each carrying the engineered edge features (`winProb`, `atk/8`, `def/8`; v2 [D-17] adds
 *     three attack-consequence features — post-capture retaliation, vacated-source exposure,
 *     target enemy-surround) so the net never has to learn dice math or look ahead one ply.
 *     The mask is all-ones over exactly this set (the legal set IS `getValidMoves` + STOP —
 *     see {@link import('./trajectoryExport.js').trajectoryFromReplay}).
 *   - **BC label** — the index of the teacher's `chosenMove` within that action list.
 *   - **Aux value head** — terminal `won` + normalized `placement` (1 = first … 0 = last),
 *     a recommended multi-task target that warm-starts Phase-3 PPO.
 *
 * The encoder is **pure** and stateless: feed it a step + the per-game context
 * (`maxAreas`, `playerCount`, terminal `winner`/`placements`) and it returns plain arrays.
 * Packing those into a binary corpus for the Python trainer is the CLI's job
 * (`scripts/encode-corpus.mjs`), keeping serialization out of the verifiable core.
 *
 * @module arena/encodeObservation
 */

import { MAX_DICE, winProbability } from '../ai/diceOdds.js';
import { STOCK_MAX } from '../engine/constants.js';
import { isStopMove } from './trajectoryExport.js';

/**
 * Encoding-contract version. Bump when the feature layout below changes
 * incompatibly (separate from OBSERVATION_SCHEMA_VERSION, which stamps the
 * on-disk lean record; this stamps the *expanded tensor* layout).
 */
export const ENCODING_VERSION = 2;

/**
 * Per-node feature names, in tensor-column order. One row per territory id
 * `0 .. maxAreas-1`; absent ids (no present area) are all-zero (`present = 0`).
 *
 * v2 (ml-bot Phase-3 ceiling probe, [D-17]) appends three **local-neighbourhood**
 * features so the per-node MLP sees the board structure the v1 encoding withheld
 * (the v1 corpus carried no adjacency at all). All are **relational to the acting
 * seat** (`enemy` = owner ≠ me), preserving seat-symmetry.
 * @type {readonly string[]}
 */
export const NODE_FEATURES = Object.freeze([
  'present', // 1 if a present area occupies this id; absent ids stay 0 (allAreas is pre-filtered upstream)
  'diceNorm', // dice / MAX_DICE
  'isMine', // owner === me
  'isEnemy', // present && owner !== me
  'isBorder', // BotState.isBorder (adjacent to a differently-owned area)
  'enemyNbrDiceMaxNorm', // v2: max dice among enemy neighbours / MAX_DICE (biggest incoming threat); 0 if none
  'enemyNbrFrac', // v2: enemy neighbours / total neighbours; 0 if isolated
  'degreeNorm', // v2: neighbour count / NEIGHBOR_DEGREE_NORM (connectivity / exposure)
]);

/**
 * Per-player (per-seat) global feature names, in tensor-column order. One row
 * per seat; `isMe` marks the acting player. Owner identity is carried only
 * relationally (`isMe`) — never as a seat one-hot.
 * @type {readonly string[]}
 */
export const PLAYER_FEATURES = Object.freeze([
  'isMe', // this seat is the acting (teacher) player
  'eliminated', // 1 if knocked out
  'territoriesFrac', // territories / total board territories
  'diceFrac', // totalDice / total dice in play
  'connectedFrac', // largestGroup / total board territories
  'stockNorm', // reinforcements / STOCK_MAX
]);

/**
 * Board-scalar feature names, in vector order. Global to the step, not per-seat.
 * `gamePhase` is one-hot (early/mid/late).
 * @type {readonly string[]}
 */
export const BOARD_FEATURES = Object.freeze([
  'myDiceShare', // my totalDice / total dice in play
  'activeFrac', // activePlayers / totalPlayers
  'phaseEarly',
  'phaseMid',
  'phaseLate',
]);

/**
 * Per-edge feature names, in tensor-column order. One row per entry in the
 * action head (`legalMoves` = `getValidMoves` output + a trailing STOP). The
 * from/to node representations are gathered separately via `edgeIndex`.
 * @type {readonly string[]}
 */
export const EDGE_FEATURES = Object.freeze([
  'winProb', // WIN_TABLE[attackerDice][defenderDice]
  'atkNorm', // attackerDice / MAX_DICE
  'defNorm', // defenderDice / MAX_DICE
  'isStop', // 1 for the STOP action, 0 for an attack
  'tgtRetakeThreatNorm', // v2: after capture, max enemy dice adjacent to `to` (excl. `from`) / MAX_DICE — immediate retaliation risk
  'srcVacateThreatNorm', // v2: max enemy dice adjacent to `from`'s OTHER neighbours / MAX_DICE — exposure from emptying the attacker
  'tgtEnemyNbrFrac', // v2: enemy neighbours of `to` (excl. `from`) / its neighbour count — how surrounded the prize is
]);

const PHASE_INDEX = Object.freeze({ early: 0, mid: 1, late: 2 });

/**
 * Degree (neighbour-count) normalizer for `degreeNorm`. Hex territories rarely
 * exceed ~6 neighbours; 8 leaves headroom and keeps the feature in [0, ~1].
 */
const NEIGHBOR_DEGREE_NORM = 8;

/**
 * The trailing STOP action's edge-feature row: all features 0 except `isStop`
 * (column 3). Width tracks EDGE_FEATURES so v-bumps can't silently mis-size it.
 * @type {number[]}
 */
const STOP_EDGE = EDGE_FEATURES.map(name => (name === 'isStop' ? 1 : 0));

/**
 * Relational (acting-seat `me`) summary of one area's neighbourhood: how many
 * present neighbours it has (optionally excluding one id), how many are
 * enemy-owned, and the largest enemy dice among them. The single primitive both
 * the v2 node features and the v2 edge-consequence features are built from, so
 * the train (`encodeStep`) and inference (`encodeObservationForInference`) paths
 * can't drift.
 *
 * @param {import('./types.js').BotArea} area
 * @param {Map<number, import('./types.js').BotArea>} areaById - present areas by id
 * @param {number} me - acting seat (owner === me ⇒ mine, else enemy)
 * @param {number} [exceptId=-1] - a neighbour id to skip (e.g. the attack's other endpoint)
 * @returns {{ degree: number, enemyCount: number, enemyDiceMax: number }}
 */
function neighborStats(area, areaById, me, exceptId = -1) {
  let degree = 0;
  let enemyCount = 0;
  let enemyDiceMax = 0;
  for (const nbrId of area.neighbors) {
    if (nbrId === exceptId) continue;
    const nbr = areaById.get(nbrId);
    if (!nbr) continue; // absent neighbour (allAreas is pre-filtered, but stay safe)
    degree++;
    if (nbr.owner !== me) {
      enemyCount++;
      if (nbr.dice > enemyDiceMax) enemyDiceMax = nbr.dice;
    }
  }
  return { degree, enemyCount, enemyDiceMax };
}

/**
 * The full edge-feature row for one attack `from → to`, shared by the train and
 * inference encoders. The first three (winProb, atk/8, def/8) and `isStop = 0`
 * are the v1 features; the last three are the v2 attack-consequence features
 * ([D-17]), each a deterministic function of the *current* board (no leakage).
 *
 * @param {import('./types.js').BotArea} fromArea
 * @param {import('./types.js').BotArea} toArea
 * @param {Map<number, import('./types.js').BotArea>} areaById
 * @param {number} me
 * @returns {number[]} EDGE_FEATURES-wide row
 */
function attackEdgeFeatures(fromArea, toArea, areaById, me) {
  const tgt = neighborStats(toArea, areaById, me, fromArea.id); // `to`'s other neighbours
  const src = neighborStats(fromArea, areaById, me, toArea.id); // `from`'s other neighbours
  return [
    winProbability(fromArea.dice, toArea.dice),
    fromArea.dice / MAX_DICE,
    toArea.dice / MAX_DICE,
    0, // isStop
    tgt.enemyDiceMax / MAX_DICE,
    src.enemyDiceMax / MAX_DICE,
    tgt.degree ? tgt.enemyCount / tgt.degree : 0,
  ];
}

/**
 * @typedef {Object} EncodeContext
 * @property {number} maxAreas    - Node-tensor width (config.maxAreas; ids 0..maxAreas-1)
 * @property {number} playerCount - Globals-tensor height (number of seats)
 * @property {number|null} winner - Terminal winner seat (null = stalemate)
 * @property {number[]} placements - Terminal placement order (placements[0] = best)
 */

/**
 * @typedef {Object} EncodedStep
 * @property {number} playerId   - Acting seat (the teacher seat being cloned)
 * @property {number} turnNumber - Engine turn number at the decision
 * @property {number[][]} nodes  - [maxAreas][NODE_FEATURES.length]
 * @property {number[][]} players - [playerCount][PLAYER_FEATURES.length]
 * @property {number[]} board    - [BOARD_FEATURES.length]
 * @property {number[][]} edges  - [numEdges][EDGE_FEATURES.length]; numEdges = legalMoves.length
 * @property {number[][]} edgeIndex - [numEdges][2] (fromId, toId); STOP → [0, 0]
 * @property {number[]} mask     - [numEdges]; all 1 (legal set is exactly getValidMoves + STOP)
 * @property {number} label      - Chosen edge index within `edges` (the BC target)
 * @property {{won: number, placement: number}} value - Aux value-head target
 */

/**
 * Build the per-node feature matrix: one row per territory id `0 .. maxAreas-1`.
 * Row 0 (the sentinel) and any absent id are all-zero with `present = 0`.
 *
 * @param {import('./types.js').BotState} obs - The step's sanitized observation
 * @param {number} me - The acting seat
 * @param {number} maxAreas
 * @param {Map<number, import('./types.js').BotArea>} areaById - present areas by id (for v2 neighbour features)
 * @returns {number[][]}
 */
function encodeNodes(obs, me, maxAreas, areaById) {
  const nodes = Array.from({ length: maxAreas }, () => new Array(NODE_FEATURES.length).fill(0));
  for (const area of obs.allAreas) {
    if (area.id < 0 || area.id >= maxAreas) {
      throw new Error(
        `encodeObservation: area id ${area.id} out of node range [0, ${maxAreas}); ` +
          `config.maxAreas too small for this board.`
      );
    }
    const isMine = area.owner === me ? 1 : 0;
    const s = neighborStats(area, areaById, me); // all present neighbours
    nodes[area.id] = [
      1, // present
      area.dice / MAX_DICE,
      isMine,
      isMine ? 0 : 1, // isEnemy (present here by construction, so !mine ⇒ enemy)
      area.isBorder ? 1 : 0,
      s.enemyDiceMax / MAX_DICE, // enemyNbrDiceMaxNorm
      s.degree ? s.enemyCount / s.degree : 0, // enemyNbrFrac
      s.degree / NEIGHBOR_DEGREE_NORM, // degreeNorm
    ];
  }
  return nodes;
}

/**
 * Build the per-player globals matrix and the board-scalar vector together
 * (they share the same denominators).
 *
 * @param {import('./types.js').BotState} obs
 * @param {number} me
 * @param {number} totalTerritories - Present-area count (board territory total)
 * @returns {{ players: number[][], board: number[] }}
 */
function encodeGlobals(obs, me, totalTerritories) {
  const totalDice = obs.players.reduce((sum, p) => sum + p.totalDice, 0);
  /*
   * Guard the denominators: a 0-territory / 0-dice board can't arise mid-decision
   * (the acting player has a move), but division must stay finite regardless.
   */
  const terrDen = totalTerritories || 1;
  const diceDen = totalDice || 1;

  const players = obs.players.map(p => [
    p.id === me ? 1 : 0,
    p.eliminated ? 1 : 0,
    p.territories / terrDen,
    p.totalDice / diceDen,
    p.connectedTerritories / terrDen,
    p.reinforcements / STOCK_MAX,
  ]);

  /*
   * Surface a corrupt step loudly rather than defaulting silently: the acting seat
   * must appear among the per-seat globals, and gamePhase must be a known bucket.
   * A silent `?? 0` / `?? mid` here would quietly poison `myDiceShare` / the phase
   * one-hot for a whole game instead of flagging the contract break.
   */
  const self = obs.players.find(p => p.id === me);
  if (!self) {
    throw new Error(
      `encodeObservation: acting seat ${me} is not among the step's ${obs.players.length} players.`
    );
  }
  const myDice = self.totalDice;

  const phase = PHASE_INDEX[obs.gamePhase];
  if (phase === undefined) {
    throw new Error(
      `encodeObservation: unknown gamePhase "${obs.gamePhase}" (expected early|mid|late).`
    );
  }
  const board = [
    myDice / diceDen,
    obs.activePlayers / obs.totalPlayers,
    phase === PHASE_INDEX.early ? 1 : 0,
    phase === PHASE_INDEX.mid ? 1 : 0,
    phase === PHASE_INDEX.late ? 1 : 0,
  ];

  return { players, board };
}

/**
 * Build the action head (edge features + gather indices) and find the label.
 * Iterates `legalMoves` in order, so the edge index equals the legal-move index
 * — which is exactly what `label` points into.
 *
 * @param {Array<Object>} legalMoves - getValidMoves output + a trailing STOP
 * @param {{from:number,to:number}|{type:string}} chosenMove
 * @param {Map<number, import('./types.js').BotArea>} areaById - present areas by id (for v2 edge features)
 * @param {number} me - acting seat (for relational v2 edge features)
 * @returns {{ edges: number[][], edgeIndex: number[][], mask: number[], label: number }}
 */
function encodeActions(legalMoves, chosenMove, areaById, me) {
  const edges = [];
  const edgeIndex = [];
  let label = -1;
  const chosenIsStop = isStopMove(chosenMove);

  for (let i = 0; i < legalMoves.length; i++) {
    const move = legalMoves[i];
    if (isStopMove(move)) {
      edges.push(STOP_EDGE.slice());
      edgeIndex.push([0, 0]);
      if (chosenIsStop) label = i;
    } else {
      const fromArea = areaById.get(move.from);
      const toArea = areaById.get(move.to);
      if (!fromArea || !toArea) {
        throw new Error(
          `encodeObservation: legal move ${move.from}->${move.to} references an area absent from ` +
            `allAreas — cannot build its edge features.`
        );
      }
      edges.push(attackEdgeFeatures(fromArea, toArea, areaById, me));
      edgeIndex.push([move.from, move.to]);
      if (!chosenIsStop && move.from === chosenMove.from && move.to === chosenMove.to) {
        label = i;
      }
    }
  }

  if (label < 0) {
    /*
     * The teacher's applied move must be a member of its own legal set. A miss
     * means corrupt data or a legalMoves/chosenMove mismatch — a poisoned BC
     * target. Fail loudly rather than silently emitting label -1.
     */
    throw new Error(
      `encodeObservation: chosenMove ${JSON.stringify(chosenMove)} not found in legalMoves ` +
        `(${legalMoves.length} entries) — cannot assign a BC label.`
    );
  }

  /*
   * The legal set is exactly getValidMoves + STOP, so every entry is legal:
   * the mask is all-ones (kept explicit for the net's masked-softmax contract).
   */
  const mask = new Array(legalMoves.length).fill(1);
  return { edges, edgeIndex, mask, label };
}

/**
 * Assert the encoded tensors match their declared shapes before they are packed:
 * each dense tensor as tall as its ctx dim, each row exactly as wide as its
 * feature-name array. Converts a silent column/row drift (e.g. a feature name
 * added to `NODE_FEATURES` without widening its row literal) into a loud,
 * immediate throw — the on-disk `shape` in the manifest is derived from these
 * same lengths, so a drift would otherwise pack a blob the Python loader silently
 * mis-`reshape`s. O(1): rows are built uniformly, so the first of each is
 * representative of its width.
 *
 * @param {{nodes:number[][], players:number[][], board:number[], edges:number[][]}} t
 * @param {number} maxAreas
 * @param {number} playerCount
 */
function assertShapeContract(t, maxAreas, playerCount) {
  const checks = [
    ['nodes height', t.nodes.length, maxAreas],
    ['players height', t.players.length, playerCount],
    ['nodes width', t.nodes[0]?.length, NODE_FEATURES.length],
    ['players width', t.players[0]?.length, PLAYER_FEATURES.length],
    ['board width', t.board.length, BOARD_FEATURES.length],
    ['edges width', t.edges[0]?.length, EDGE_FEATURES.length],
  ];
  for (const [what, got, want] of checks) {
    if (got !== want) {
      throw new Error(
        `encodeObservation: ${what} ${got} ≠ expected ${want} — a row builder drifted from its ` +
          `feature-name array (or a dims mismatch); the packed tensor layout would be corrupt.`
      );
    }
  }
}

/**
 * Encode one fat trajectory step into BC tensors per the D-Encoding contract.
 *
 * Pure: depends only on the step and the per-game context. The caller is
 * responsible for filtering steps to the teacher seat before calling this
 * (the value/label are computed relative to `step.playerId`).
 *
 * @param {import('./trajectoryExport.js').TrajectoryStep} step
 * @param {EncodeContext} ctx
 * @returns {EncodedStep}
 * @throws {Error} On a player-count mismatch, an acting seat absent from the
 *   step's players, an unknown `gamePhase`, an area id outside `[0, maxAreas)`,
 *   a `chosenMove` absent from `legalMoves`, or an encoded-tensor shape that
 *   drifts from the declared feature-column counts.
 */
export function encodeStep(step, ctx) {
  const { maxAreas, playerCount, winner, placements } = ctx;
  const me = step.playerId;
  const obs = step.observation;

  if (obs.players.length !== playerCount) {
    throw new Error(
      `encodeObservation: step has ${obs.players.length} players but ctx.playerCount=${playerCount}.`
    );
  }

  const areaById = new Map(obs.allAreas.map(a => [a.id, a]));
  const nodes = encodeNodes(obs, me, maxAreas, areaById);
  const { players, board } = encodeGlobals(obs, me, obs.allAreas.length);
  const { edges, edgeIndex, mask, label } = encodeActions(
    step.legalMoves,
    step.chosenMove,
    areaById,
    me
  );

  /*
   * Aux value head: terminal outcome relative to the acting seat. `placements`
   * is best-first, so indexOf(me) is the 0-based rank → normalize to 1 (first)
   * … 0 (last). Stalemates have a valid placement ranking even with winner=null.
   */
  const rank = placements.indexOf(me);
  const placement = playerCount > 1 && rank >= 0 ? 1 - rank / (playerCount - 1) : 0;

  // Loud guard against a row builder drifting from its declared columns (see fn).
  assertShapeContract({ nodes, players, board, edges }, maxAreas, playerCount);

  return {
    playerId: me,
    turnNumber: step.turnNumber,
    nodes,
    players,
    board,
    edges,
    edgeIndex,
    mask,
    label,
    value: { won: winner === me ? 1 : 0, placement },
  };
}

/**
 * Encode a live {@link import('./types.js').BotState} into the model's input
 * tensors for **inference** — the label-free counterpart of {@link encodeStep}.
 *
 * The in-browser BC bot only has a `BotState` (no `GameState`), so it can't call
 * `getValidMoves`; this reconstructs the exact same legal set from `allAreas`
 * (each present, dice>1 area attacking each present enemy neighbour — mirroring
 * `getValidMoves` in `StateManager.js`) and appends the explicit STOP. Edge order
 * is irrelevant at inference: the net emits one logit per edge and the caller
 * argmaxes, mapping the winning index back to its move via the returned `moves`.
 *
 * Returns the same node/player/board/edge tensors `encodeStep` builds (reusing the
 * identical encoders, so train and inference can't drift) plus a parallel `moves`
 * array: `{from,to}` for an attack, `null` for STOP.
 *
 * @param {import('./types.js').BotState} botState
 * @param {{ maxAreas: number }} ctx - node-tensor width (the model's config.maxAreas)
 * @returns {{ nodes:number[][], players:number[][], board:number[], edges:number[][],
 *   edgeIndex:number[][], moves:Array<{from:number,to:number}|null> }}
 */
export function encodeObservationForInference(botState, ctx) {
  const me = botState.myPlayer;
  const areaById = new Map(botState.allAreas.map(a => [a.id, a]));
  const nodes = encodeNodes(botState, me, ctx.maxAreas, areaById);
  const { players, board } = encodeGlobals(botState, me, botState.allAreas.length);

  const edges = [];
  const edgeIndex = [];
  const moves = [];
  for (const area of botState.allAreas) {
    if (area.owner !== me || area.dice <= 1) continue;
    for (const adjId of area.neighbors) {
      const adj = areaById.get(adjId); // present (in allAreas) ...
      if (!adj || adj.owner === me) continue; // ... and enemy-owned
      edges.push(attackEdgeFeatures(area, adj, areaById, me));
      edgeIndex.push([area.id, adj.id]);
      moves.push({ from: area.id, to: adj.id });
    }
  }
  // Trailing STOP — the legal set is exactly getValidMoves + STOP.
  edges.push(STOP_EDGE.slice());
  edgeIndex.push([0, 0]);
  moves.push(null);

  return { nodes, players, board, edges, edgeIndex, moves };
}

/**
 * The teacher seats of a trajectory record: seats whose bot's base name (the
 * `#n` duplicate-seat suffix stripped) equals `teacherName`.
 *
 * @param {import('./trajectoryExport.js').TrajectoryRecord} record
 * @param {string} teacherName - Base bot name to imitate (e.g. 'Lookahead')
 * @returns {number[]} Seat indices to clone
 */
export function teacherSeatsOf(record, teacherName) {
  const seats = [];
  record.metadata.bots.forEach((name, seat) => {
    if (name.replace(/#\d+$/, '') === teacherName) seats.push(seat);
  });
  return seats;
}
