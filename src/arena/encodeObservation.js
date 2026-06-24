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
 *     is seat-symmetric.
 *   - **Per-player globals** — one row per seat (`isMe` marks self), the quantities the
 *     teacher's posture/leader terms key off.
 *   - **Board scalars** — my dice-share, active fraction, game-phase one-hot.
 *   - **Action head** — one row per legal move from `getValidMoves` plus an explicit STOP,
 *     each carrying the engineered edge features (`winProb`, `atk/8`, `def/8`) so the net
 *     never has to learn dice math. The mask is all-ones over exactly this set (the legal
 *     set IS `getValidMoves` + STOP — see {@link import('./trajectoryExport.js').trajectoryFromReplay}).
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
export const ENCODING_VERSION = 1;

/**
 * Per-node feature names, in tensor-column order. One row per territory id
 * `0 .. maxAreas-1`; absent ids (no present area) are all-zero (`present = 0`).
 * @type {readonly string[]}
 */
export const NODE_FEATURES = Object.freeze([
  'present', // 1 if a present area occupies this id; absent ids stay 0 (allAreas is pre-filtered upstream)
  'diceNorm', // dice / MAX_DICE
  'isMine', // owner === me
  'isEnemy', // present && owner !== me
  'isBorder', // BotState.isBorder (adjacent to a differently-owned area)
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
]);

const PHASE_INDEX = Object.freeze({ early: 0, mid: 1, late: 2 });

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
 * @returns {number[][]}
 */
function encodeNodes(obs, me, maxAreas) {
  const nodes = Array.from({ length: maxAreas }, () => [0, 0, 0, 0, 0]);
  for (const area of obs.allAreas) {
    if (area.id < 0 || area.id >= maxAreas) {
      throw new Error(
        `encodeObservation: area id ${area.id} out of node range [0, ${maxAreas}); ` +
          `config.maxAreas too small for this board.`
      );
    }
    const isMine = area.owner === me ? 1 : 0;
    nodes[area.id] = [
      1, // present
      area.dice / MAX_DICE,
      isMine,
      isMine ? 0 : 1, // isEnemy (present here by construction, so !mine ⇒ enemy)
      area.isBorder ? 1 : 0,
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
 * @returns {{ edges: number[][], edgeIndex: number[][], mask: number[], label: number }}
 */
function encodeActions(legalMoves, chosenMove) {
  const edges = [];
  const edgeIndex = [];
  let label = -1;
  const chosenIsStop = isStopMove(chosenMove);

  for (let i = 0; i < legalMoves.length; i++) {
    const move = legalMoves[i];
    if (isStopMove(move)) {
      edges.push([0, 0, 0, 1]);
      edgeIndex.push([0, 0]);
      if (chosenIsStop) label = i;
    } else {
      edges.push([
        winProbability(move.attackerDice, move.defenderDice),
        move.attackerDice / MAX_DICE,
        move.defenderDice / MAX_DICE,
        0,
      ]);
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

  const nodes = encodeNodes(obs, me, maxAreas);
  const { players, board } = encodeGlobals(obs, me, obs.allAreas.length);
  const { edges, edgeIndex, mask, label } = encodeActions(step.legalMoves, step.chosenMove);

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
  const nodes = encodeNodes(botState, me, ctx.maxAreas);
  const { players, board } = encodeGlobals(botState, me, botState.allAreas.length);

  const areaById = new Map(botState.allAreas.map(a => [a.id, a]));
  const edges = [];
  const edgeIndex = [];
  const moves = [];
  for (const area of botState.allAreas) {
    if (area.owner !== me || area.dice <= 1) continue;
    for (const adjId of area.neighbors) {
      const adj = areaById.get(adjId); // present (in allAreas) ...
      if (!adj || adj.owner === me) continue; // ... and enemy-owned
      edges.push([
        winProbability(area.dice, adj.dice),
        area.dice / MAX_DICE,
        adj.dice / MAX_DICE,
        0,
      ]);
      edgeIndex.push([area.id, adj.id]);
      moves.push({ from: area.id, to: adj.id });
    }
  }
  // Trailing STOP — the legal set is exactly getValidMoves + STOP.
  edges.push([0, 0, 0, 1]);
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
