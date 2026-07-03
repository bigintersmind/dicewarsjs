/**
 * Observation Encoder — the Phase-2 tensor-expansion pass (docs/ml-bot/).
 *
 * Turns one re-derived fat trajectory step (a {@link import('./trajectoryExport.js').TrajectoryStep})
 * into the fixed-shape numeric tensors the policy nets consume, per the
 * **D-Encoding** contract in `docs/ml-bot/DECISIONS.md` (v3 additions: [D-31]):
 *
 *   - **Nodes** — a graph over the fixed territory-id node space `0 .. maxAreas-1` (id 0 is
 *     the unused sentinel). One row per id; absent ids are zero with `present = 0`. Features
 *     are **relational** (`isMine`/`isEnemy`), never an absolute seat one-hot, so the policy
 *     is seat-symmetric. v2 ([D-18]) adds three local-neighbourhood features (enemy-threat
 *     magnitude, enemy fraction, degree) so the per-node MLP sees board structure. v3
 *     ([D-31]) paints the OWNER's strength onto each node (territory/income/dice share —
 *     identity carried as attributes, still no seat index) plus the two income-consequence
 *     values (cut value if the node flips, my gain if I capture it).
 *   - **Per-player globals** — one row per seat (`isMe` marks self), the quantities the
 *     teacher's posture/leader terms key off. v3 adds `turnsUntilActsNorm` (turn-order
 *     distance from the acting seat).
 *   - **Board scalars** — my dice-share, active fraction, game-phase one-hot. v3 adds my
 *     stock and the turn clock (completed player-turns / stalemate cap).
 *   - **Action head** — one row per legal move from `getValidMoves` plus an explicit STOP,
 *     each carrying the engineered edge features (`winProb`, `atk/8`, `def/8`; v2 [D-18] adds
 *     three attack-consequence features — post-capture retaliation, vacated-source exposure,
 *     target enemy-surround; v3 [D-31] adds elimination and the income deltas gathered from
 *     the target node) so the net never has to learn dice math or look ahead one ply.
 *     The mask is all-ones over exactly this set (the legal set IS `getValidMoves` + STOP —
 *     see {@link import('./trajectoryExport.js').trajectoryFromReplay}).
 *   - **BC label** — the index of the teacher's `chosenMove` within that action list.
 *   - **Aux value head** — terminal `won` + normalized `placement` (1 = first … 0 = last),
 *     a recommended multi-task target that warm-starts Phase-3 PPO.
 *
 * **v2 compatibility ([D-31] append-only rule):** every v3 column is appended AFTER the v2
 * columns, which are byte-identical to what a v2 encoder produced. A v2-stamped policy run
 * through `bcForward` therefore ignores the appended tail (its first-layer weights are
 * narrower and every concat keeps the variable-width tensor last) — numerically exact v2
 * behavior with no adapter allocation. {@link assertPolicyEncodingCompatible} is the loud
 * gate: it accepts any {@link SUPPORTED_ENCODING_VERSIONS} policy whose widths are ≤ the
 * live arrays, and rejects everything else (a wider-than-encoder policy would read NaN).
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
import { computeGroups, cutValueFor, myGainIfCaptured } from './groupIncome.js';
import { DEFAULT_MAX_TURNS } from './matchRunner.js';
import { isStopMove } from './trajectoryExport.js';

/**
 * Encoding-contract version. Bump when the feature layout below changes
 * incompatibly (separate from OBSERVATION_SCHEMA_VERSION, which stamps the
 * on-disk lean record; this stamps the *expanded tensor* layout).
 */
export const ENCODING_VERSION = 3;

/**
 * Encoding versions a policy may be stamped with and still run against this
 * encoder. v2 is the strict column-prefix of v3 (the [D-31] append-only rule),
 * so v2 nets consume v3 tensors by ignoring the appended tail columns — see
 * {@link assertPolicyEncodingCompatible}. Remove a version from this list only
 * when a change breaks the prefix property.
 * @type {readonly number[]}
 */
export const SUPPORTED_ENCODING_VERSIONS = Object.freeze([2, 3]);

/**
 * Per-node feature names, in tensor-column order. One row per territory id
 * `0 .. maxAreas-1`; absent ids (no present area) are all-zero (`present = 0`).
 *
 * v2 (ml-bot Phase-3 ceiling probe, [D-18]) appends three **local-neighbourhood**
 * features so the per-node MLP sees the board structure the v1 encoding withheld
 * (the v1 corpus carried no adjacency at all). All are **relational to the acting
 * seat** (`enemy` = owner ≠ me), preserving seat-symmetry.
 *
 * v3 ([D-31]) appends the **owner-attribute + income-consequence** features: the
 * node's owner carried as strength/income attributes (never a seat one-hot — the
 * net learns "belongs to a 40%-income player", not "belongs to seat 3") and the
 * two capture-consequence deltas from `groupIncome.js`. Placing owner stats on
 * nodes also routes them around the player-pool mean-pooling bottleneck.
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
  'ownerTerrFrac', // v3: owner's territories / board territories (how big the owner is)
  'ownerIncomeFrac', // v3: owner's largest connected group / board territories (their income)
  'ownerDiceFrac', // v3: owner's total dice / dice in play (their strength)
  'cutValueNorm', // v3: owner income lost if this node flips / board (my bridge to defend; their chain to cut)
  'myGainIfCapturedNorm', // v3: my income delta if I take this node / board (0 for my own nodes)
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
  'turnsUntilActsNorm', // v3: turn-advances until this seat acts / (activePlayers-1); self & eliminated = 0
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
  'myStockNorm', // v3: my reinforcement stock / STOCK_MAX (duplicates my player-row stock past the mean-pool, like myDiceShare)
  /*
   * turnClockNorm (v3): turnsTaken / DEFAULT_MAX_TURNS, clamped to 1 — the stalemate/truncation
   * clock. turnsTaken counts COMPLETED player-turns (the same unit as matchRunner's turnCount),
   * so at a decision during player-turn N the column reads (N-1)/500 and hits 1 exactly at the
   * truncation boundary. Deliberately normalized by the frozen constant, NOT a per-run maxTurns
   * (cap-tracking would make the column's semantics config-dependent and force a version bump);
   * harnesses with a non-default cap — and browser/live games, which have no cap — get a nominal
   * clock. Constant across all decisions within one player-turn, by design.
   */
  'turnClockNorm',
]);

/**
 * Per-edge feature names, in tensor-column order. One row per entry in the
 * action head (`legalMoves` = `getValidMoves` output + a trailing STOP). The
 * from/to node representations are gathered separately via `edgeIndex`.
 *
 * v3 ([D-31]) appends the move consequences a human reads off the board: does
 * this capture eliminate its owner, and what does it do to each side's income.
 * The income deltas are the target node's `cutValueNorm`/`myGainIfCapturedNorm`
 * gathered onto the edge row (same numbers by construction — one computation in
 * the shared context), following the v2 precedent of handing the edge head
 * direct consequence features rather than relying on the node embeddings.
 * @type {readonly string[]}
 */
export const EDGE_FEATURES = Object.freeze([
  'winProb', // WIN_TABLE[attackerDice][defenderDice]
  'atkNorm', // attackerDice / MAX_DICE
  'defNorm', // defenderDice / MAX_DICE
  'isStop', // 1 for the STOP action, 0 for an attack
  'tgtRetakeThreatNorm', // v2: max enemy dice adjacent to `to` (excl. `from`) / MAX_DICE — current-board proxy for post-capture retaliation risk
  'srcVacateThreatNorm', // v2: max enemy dice among `from`'s OTHER neighbours (excl. `to`) / MAX_DICE — exposure left behind when the attacker empties to 1 die
  'tgtEnemyNbrFrac', // v2: enemy neighbours of `to` (excl. `from`) / its neighbour count — how surrounded the prize is
  'eliminatesDefender', // v3: 1 if capturing `to` removes its owner's last territory
  'defIncomeDeltaNorm', // v3: = to.cutValueNorm — income the defender's owner loses to this capture
  'myIncomeDeltaNorm', // v3: = to.myGainIfCapturedNorm — income I gain from this capture
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
 * Throw unless `policy` can run against the live encoder: its stamped
 * `encodingVersion` must be in {@link SUPPORTED_ENCODING_VERSIONS}, and any
 * config feature widths it declares must not exceed the live arrays. The width
 * check is what makes accepting old versions safe: a supported-but-narrower
 * policy simply ignores the appended tail columns inside `bcForward`'s
 * `linear()` (weights drive the loop bounds), while a *wider* policy would
 * multiply against missing columns and emit NaN — so it is rejected loudly.
 * Width fields are belt-and-braces over the version stamp (real exports always
 * carry them; `export_weights.py` stamps the full config): a policy that omits
 * one is judged by its version alone, since a missing width cannot be wider —
 * but a width that is *present yet not a finite number* (a corrupt or
 * hand-edited export) is rejected rather than silently skipped. And because a
 * config can lie, when `policy.layers` is present the widths the net actually
 * consumes are re-derived from its first-layer weight rows (see
 * `bcForward.forward`: nodeEncoder/playerEncoder take the raw feature row;
 * context takes [nodePool, playerPool, board]; edgeHead takes
 * [ctx, fromEmb, toEmb, edgeFeatures]) and held to the same ≤-live bound.
 *
 * @param {{encodingVersion: number, config: Object, layers?: Object}} policy - exported weights module payload
 * @param {string} label - caller tag for the error message (e.g. 'makeBC', 'league snapshot')
 * @throws {Error} On an unsupported version, a non-finite declared width, or a declared/actual
 *   width wider than the encoder
 */
export function assertPolicyEncodingCompatible(policy, label) {
  if (!SUPPORTED_ENCODING_VERSIONS.includes(policy.encodingVersion)) {
    throw new Error(
      `${label}: policy encodingVersion ${policy.encodingVersion} not in supported set ` +
        `[${SUPPORTED_ENCODING_VERSIONS.join(', ')}] (encoder ENCODING_VERSION ${ENCODING_VERSION}) ` +
        `— retrain/re-export against a supported encoding.`
    );
  }
  const widths = [
    ['nodeFeatures', NODE_FEATURES.length],
    ['playerFeatures', PLAYER_FEATURES.length],
    ['boardFeatures', BOARD_FEATURES.length],
    ['edgeFeatures', EDGE_FEATURES.length],
  ];
  for (const [key, live] of widths) {
    const got = policy.config?.[key];
    if (got === undefined) continue; // genuinely absent → judged by version alone
    if (typeof got !== 'number' || !Number.isFinite(got)) {
      throw new Error(
        `${label}: policy config.${key} = ${got} is not a finite number — the export is ` +
          `corrupt (or hand-edited); refusing to guess its width.`
      );
    }
    if (got > live) {
      throw new Error(
        `${label}: policy config.${key} = ${got} exceeds the live encoder width ${live} — a ` +
          `wider-than-encoder net would read NaN. Re-export the policy or widen the encoder first.`
      );
    }
  }

  /*
   * Belt over the belt: the config widths are metadata, but the first-layer weight
   * rows are what linear() actually multiplies against the encoded rows. Derive the
   * per-tensor input widths the net truly consumes and enforce the same bound — a
   * policy whose config under-declares its widths must not slip past on paperwork.
   * Hidden dims come from the encoders' own output layers, mirroring forward()'s
   * concat layout, so the feature share of each mixed input is exact.
   */
  const { layers } = policy;
  if (layers) {
    const firstIn = head => layers[head]?.[0]?.w?.[0]?.length;
    const lastOut = head => layers[head]?.[layers[head].length - 1]?.b?.length;
    const nodeHidden = lastOut('nodeEncoder');
    const playerHidden = lastOut('playerEncoder');
    const ctxHidden = lastOut('context');
    const actuals = [
      ['nodeFeatures', firstIn('nodeEncoder'), NODE_FEATURES.length],
      ['playerFeatures', firstIn('playerEncoder'), PLAYER_FEATURES.length],
      // context input = [nodePool, playerPool, board] — board is the variable tail
      ['boardFeatures', firstIn('context') - nodeHidden - playerHidden, BOARD_FEATURES.length],
      // edgeHead input = [ctx, fromEmb, toEmb, edgeFeatures] — edge row is the tail
      ['edgeFeatures', firstIn('edgeHead') - ctxHidden - 2 * nodeHidden, EDGE_FEATURES.length],
    ];
    for (const [key, actual, live] of actuals) {
      if (Number.isFinite(actual) && actual > live) {
        throw new Error(
          `${label}: policy layers consume ${actual} ${key} columns (derived from the ` +
            `first-layer weight rows) but the live encoder emits only ${live} — the net would ` +
            `read NaN regardless of what config.${key} declares. Re-export against this encoder.`
        );
      }
    }
  }
}

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
 * @typedef {Object} SharedEncodeContext
 * @property {number} me - acting seat
 * @property {Map<number, import('./types.js').BotArea>} areaById - present areas by id
 * @property {Map<number, import('./types.js').BotPlayer>} playerById - seats by id
 * @property {Map<number, {cut: number, gain: number}>} nodeIncome - per-node income
 *   consequences (cutValueFor / myGainIfCaptured), computed once and read by BOTH the
 *   node builder and the edge builder — the "edge = gathered node value" identity holds
 *   by construction
 * @property {number} terrDen - board territory count (≥ 1)
 * @property {number} diceDen - total dice in play (≥ 1)
 */

/**
 * Build the per-step shared context every tensor builder reads: id lookups,
 * normalization denominators, and the group/income analysis of the board.
 * One `computeGroups` pass + one cut/gain evaluation per node per decision.
 *
 * @param {import('./types.js').BotState} obs - the step's sanitized observation
 * @param {number} me - the acting seat
 * @returns {SharedEncodeContext}
 */
function buildSharedContext(obs, me) {
  const areaById = new Map(obs.allAreas.map(a => [a.id, a]));
  const playerById = new Map(obs.players.map(p => [p.id, p]));
  const groups = computeGroups(obs.allAreas);
  const nodeIncome = new Map();
  for (const area of obs.allAreas) {
    nodeIncome.set(area.id, {
      cut: cutValueFor(area, groups),
      gain: myGainIfCaptured(area, groups, me),
    });
  }
  const totalDice = obs.players.reduce((sum, p) => sum + p.totalDice, 0);
  /*
   * Guard the denominators: a 0-territory / 0-dice board can't arise mid-decision
   * (the acting player has a move), but division must stay finite regardless.
   */
  return {
    me,
    areaById,
    playerById,
    nodeIncome,
    terrDen: obs.allAreas.length || 1,
    diceDen: totalDice || 1,
  };
}

/**
 * The owner row for an area, or a loud throw: every present area's owner must
 * appear among the step's players, else the observation is corrupt and the v3
 * owner-attribute columns would silently encode zeros.
 *
 * @param {SharedEncodeContext} ctx
 * @param {import('./types.js').BotArea} area
 * @returns {import('./types.js').BotPlayer}
 */
function ownerOf(ctx, area) {
  const owner = ctx.playerById.get(area.owner);
  if (!owner) {
    throw new Error(
      `encodeObservation: area ${area.id} owner ${area.owner} is not among the step's ` +
        `${ctx.playerById.size} players.`
    );
  }
  return owner;
}

/**
 * The full edge-feature row for one attack `from → to`, shared by the train and
 * inference encoders. Columns 0-3 (winProb, atk/8, def/8, isStop=0) are v1;
 * columns 4-6 are the v2 attack-consequence features ([D-18]); columns 7-9 are
 * the v3 elimination/income consequences ([D-31]) — each a deterministic
 * function of the *current* board (no leakage).
 *
 * @param {import('./types.js').BotArea} fromArea
 * @param {import('./types.js').BotArea} toArea
 * @param {SharedEncodeContext} ctx
 * @returns {number[]} EDGE_FEATURES-wide row
 */
function attackEdgeFeatures(fromArea, toArea, ctx) {
  const { areaById, me, terrDen } = ctx;
  const tgt = neighborStats(toArea, areaById, me, fromArea.id); // `to`'s other neighbours
  const src = neighborStats(fromArea, areaById, me, toArea.id); // `from`'s other neighbours
  const income = ctx.nodeIncome.get(toArea.id);
  return [
    winProbability(fromArea.dice, toArea.dice),
    fromArea.dice / MAX_DICE,
    toArea.dice / MAX_DICE,
    0, // isStop
    tgt.enemyDiceMax / MAX_DICE,
    src.enemyDiceMax / MAX_DICE,
    tgt.degree ? tgt.enemyCount / tgt.degree : 0,
    ownerOf(ctx, toArea).territories === 1 ? 1 : 0, // eliminatesDefender
    income.cut / terrDen, // defIncomeDeltaNorm (= to.cutValueNorm)
    income.gain / terrDen, // myIncomeDeltaNorm (= to.myGainIfCapturedNorm)
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
 * Row 0 (the sentinel) and any absent id are all-zero (`present = 0`).
 *
 * @param {import('./types.js').BotState} obs - The step's sanitized observation
 * @param {number} maxAreas
 * @param {SharedEncodeContext} ctx
 * @returns {number[][]}
 */
function encodeNodes(obs, maxAreas, ctx) {
  const { me, areaById, terrDen, diceDen } = ctx;
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
    const owner = ownerOf(ctx, area);
    const income = ctx.nodeIncome.get(area.id);
    nodes[area.id] = [
      1, // present
      area.dice / MAX_DICE,
      isMine,
      isMine ? 0 : 1, // isEnemy (present here by construction, so !mine ⇒ enemy)
      area.isBorder ? 1 : 0,
      s.enemyDiceMax / MAX_DICE, // enemyNbrDiceMaxNorm
      s.degree ? s.enemyCount / s.degree : 0, // enemyNbrFrac
      s.degree / NEIGHBOR_DEGREE_NORM, // degreeNorm
      owner.territories / terrDen, // ownerTerrFrac
      owner.connectedTerritories / terrDen, // ownerIncomeFrac
      owner.totalDice / diceDen, // ownerDiceFrac
      income.cut / terrDen, // cutValueNorm
      income.gain / terrDen, // myGainIfCapturedNorm
    ];
  }
  return nodes;
}

/**
 * Build the per-player globals matrix and the board-scalar vector together
 * (they share the same denominators).
 *
 * @param {import('./types.js').BotState} obs
 * @param {SharedEncodeContext} ctx
 * @returns {{ players: number[][], board: number[] }}
 */
function encodeGlobals(obs, ctx) {
  const { me, terrDen, diceDen } = ctx;

  /*
   * activePlayers/totalPlayers feed denominators (turnDen, activeFrac) below; a
   * missing field on a hand-rolled BotState would silently emit NaN into the
   * tensor for a whole game. Same loud-throw treatment as turnsUntilActs.
   */
  if (typeof obs.activePlayers !== 'number' || typeof obs.totalPlayers !== 'number') {
    throw new Error(
      `encodeObservation: activePlayers/totalPlayers must be numbers (got ` +
        `${obs.activePlayers}/${obs.totalPlayers}) — BotState was built by hand without the ` +
        `sanitizer (createBotState).`
    );
  }
  if (typeof obs.turnsTaken !== 'number') {
    /*
     * The v3 turn clock needs the engine's completed-player-turn counter. A missing
     * field means a hand-rolled/stale BotState — encode nothing rather than a silent
     * NaN that would poison the column for a whole game.
     */
    throw new Error(
      `encodeObservation: BotState has no turnsTaken — it predates the engine's ` +
        `completed-player-turn counter (StateManager) or was built by hand without ` +
        `the sanitizer (createBotState).`
    );
  }

  /*
   * v3 turn-order normalizer: ranks run 0 .. activePlayers-1 (self = 0), so the
   * last seat to act before me maps to 1. The max(…, 1) keeps a heads-up or
   * terminal (1 active player) frame finite.
   */
  const turnDen = Math.max(obs.activePlayers - 1, 1);

  const players = obs.players.map(p => {
    if (typeof p.turnsUntilActs !== 'number') {
      /*
       * The v3 player row needs the sanitizer's turn-order field. A missing field
       * means a hand-rolled/stale BotState — encode nothing rather than a silent 0
       * that would poison the column for a whole game.
       */
      throw new Error(
        `encodeObservation: player ${p.id} has no turnsUntilActs — BotState predates the ` +
          `v3 sanitizer (createBotState) or was built by hand without it.`
      );
    }
    return [
      p.id === me ? 1 : 0,
      p.eliminated ? 1 : 0,
      p.territories / terrDen,
      p.totalDice / diceDen,
      p.connectedTerritories / terrDen,
      p.reinforcements / STOCK_MAX,
      p.eliminated ? 0 : p.turnsUntilActs / turnDen, // turnsUntilActsNorm
    ];
  });

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
    self.reinforcements / STOCK_MAX, // myStockNorm
    Math.min(obs.turnsTaken / DEFAULT_MAX_TURNS, 1), // turnClockNorm (see BOARD_FEATURES)
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
 * @param {SharedEncodeContext} ctx
 * @returns {{ edges: number[][], edgeIndex: number[][], mask: number[], label: number }}
 */
function encodeActions(legalMoves, chosenMove, ctx) {
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
      const fromArea = ctx.areaById.get(move.from);
      const toArea = ctx.areaById.get(move.to);
      if (!fromArea || !toArea) {
        throw new Error(
          `encodeObservation: legal move ${move.from}->${move.to} references an area absent from ` +
            `allAreas — cannot build its edge features.`
        );
      }
      edges.push(attackEdgeFeatures(fromArea, toArea, ctx));
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

  const shared = buildSharedContext(obs, me);
  const nodes = encodeNodes(obs, maxAreas, shared);
  const { players, board } = encodeGlobals(obs, shared);
  const { edges, edgeIndex, mask, label } = encodeActions(step.legalMoves, step.chosenMove, shared);

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
  const shared = buildSharedContext(botState, me);
  const nodes = encodeNodes(botState, ctx.maxAreas, shared);
  const { players, board } = encodeGlobals(botState, shared);

  const edges = [];
  const edgeIndex = [];
  const moves = [];
  for (const area of botState.allAreas) {
    if (area.owner !== me || area.dice <= 1) continue;
    for (const adjId of area.neighbors) {
      const adj = shared.areaById.get(adjId); // present (in allAreas) ...
      if (!adj || adj.owner === me) continue; // ... and enemy-owned
      edges.push(attackEdgeFeatures(area, adj, shared));
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
