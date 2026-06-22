/**
 * Lookahead - standalone shallow-expectimax strategy for Dice Wars.
 *
 * Authored by GPT-5.5.
 *
 * The bot evaluates every legal attack with exact dice odds, then estimates
 * the expected board value after the win and loss branches. Board value is
 * weighted toward the real Dice Wars economy: largest connected group,
 * territory count, dice strength, elimination pressure, and exposed borders.
 *
 * The search is intentionally shallow. The AI is called again after every
 * attack, so one-ply continuation is enough to value chain attacks without
 * making arena runs expensive. Lookahead plays its own searched move directly;
 * it shares only the exact dice-odds table with the other built-in bots.
 */

import { winProbability } from './diceOdds.js';

export { winProbability };

const MIN_PLAYER_SLOTS = 8;
const CONTINUATION_DEPTH = 1;
const EPSILON = 1e-9;

/*
 * Scoring weights, tuned against the multi-player free-for-all via the bot
 * arena (see scripts/arena-sweep.mjs). The strong safety terms — a high border
 * threat weight, a high low-odds floor, and a steep base attack threshold —
 * make the bot patient: it only commits to high-confidence, low-exposure
 * captures, which avoids the over-extension that sinks an unconstrained
 * one-ply searcher in a crowd. Re-tune with the arena sweep if the engine,
 * map generator, or opponent field changes.
 */
const TERRITORY_WEIGHT = 0.9;
const DICE_WEIGHT = 0.18;
const INCOME_WEIGHT = 1.55;
const COHESION_WEIGHT = 0.55;
const STOCK_WEIGHT = 0.05;
const BORDER_THREAT_WEIGHT = 4.5;
const LEADER_WEIGHT = 0.58;
const FIELD_WEIGHT = 0.08;
const DUEL_LEADER_WEIGHT = 1.05;
const ELIMINATION_BONUS = 5.5;
const LEADER_FOCUS_BONUS = 0.55;
const OFF_LEADER_PENALTY = 0.22;
const LOW_ODDS_FLOOR = 0.76;
const LOW_ODDS_PENALTY = 7.0;
const DOMINANCE_SHARE = 0.4;
/*
 * Posture thresholds form a U: the bot is decisive at both extremes and
 * patient in the middle. PRESS (winning) accepts even slightly-negative moves
 * to close out; WEAK (losing badly) still takes near-even fights to claw back;
 * BASE (a balanced game, the common case) is the steepest bar, so the bot only
 * spends dice on clearly profitable captures rather than gambling a level game.
 * Ordering: PRESS < WEAK < BASE.
 */
const BASE_THRESHOLD = 2.2;
const PRESS_THRESHOLD = -0.45;
const WEAK_THRESHOLD = 0.18;
/*
 * Dice-share cutoffs that select the posture above: above PRESS_DICE_SHARE
 * (strict >) the bot is dominant enough to press; below WEAK_DICE_SHARE (in a
 * crowd) it is weak enough to claw back. Between them it holds the patient BASE bar.
 */
const PRESS_DICE_SHARE = 0.38;
const WEAK_DICE_SHARE = 0.15;

function createBoard(game) {
  const areaMax = game.AREA_MAX;
  const exists = new Array(areaMax).fill(false);
  const owner = new Array(areaMax).fill(-1);
  const dice = new Array(areaMax).fill(0);
  const join = new Array(areaMax);

  let maxOwner = -1;
  for (let id = 0; id < areaMax; id++) {
    const area = game.adat[id];
    join[id] = area?.join || [];
    if (id > 0 && area && area.size !== 0) {
      exists[id] = true;
      owner[id] = area.arm;
      dice[id] = area.dice;
      if (area.arm > maxOwner) maxOwner = area.arm;
    }
  }

  /*
   * Size per-player arrays to the actual number of players this game. Games can
   * seat more than the usual 8 (e.g. a 9-bot tournament), and a fixed 8-slot
   * assumption would drop the extra player from the census and crash when that
   * player takes a turn. MIN_PLAYER_SLOTS floors the size so the usual ≤8-player
   * game keeps a fixed 8-slot array rather than a smaller per-game one.
   */
  const playerSlots = Math.max(MIN_PLAYER_SLOTS, maxOwner + 1, game.player?.length || 0);
  const stock = new Array(playerSlots).fill(0);
  for (let player = 0; player < playerSlots; player++) {
    stock[player] = game.player?.[player]?.stock || 0;
  }

  /*
   * Precompute each area's existing-neighbor list once. Adjacency and
   * existence never change during the search (only owner/dice do), so this
   * list is shared across every cloned board. Built in ascending id order to
   * preserve the iteration order of the previous dense join[] row scan.
   */
  const neighbors = new Array(areaMax);
  for (let id = 1; id < areaMax; id++) {
    if (!exists[id]) continue;
    const adjacency = join[id];
    const list = [];
    for (let other = 1; other < areaMax; other++) {
      if (adjacency[other] && exists[other]) list.push(other);
    }
    neighbors[id] = list;
  }

  return { areaMax, exists, owner, dice, join, stock, neighbors, playerSlots };
}

function cloneBoard(board) {
  return {
    areaMax: board.areaMax,
    exists: board.exists,
    owner: [...board.owner],
    dice: [...board.dice],
    join: board.join,
    stock: board.stock,
    neighbors: board.neighbors,
    playerSlots: board.playerSlots,
  };
}

function applyAttack(board, from, to, player, attackerWins) {
  const next = cloneBoard(board);

  if (attackerWins) {
    const defender = board.owner[to];
    next.owner[to] = player;
    next.dice[to] = Math.max(1, board.dice[from] - 1);
    /*
     * Only the attacker and the dispossessed defender can have a different
     * connected-group structure than the parent board.
     */
    next.changedPlayers = [player, defender];
  } else {
    /*
     * A failed attack changes no ownership, so every player's connected groups
     * are identical to the parent's.
     */
    next.changedPlayers = [];
  }
  next.dice[from] = 1;
  next.parentBoard = board;

  return next;
}

function forEachNeighbor(board, areaId, callback) {
  const list = board.neighbors[areaId];
  if (!list) return;
  for (let i = 0; i < list.length; i++) callback(list[i]);
}

function getLegalMoves(board, player) {
  const moves = [];

  for (let from = 1; from < board.areaMax; from++) {
    if (!board.exists[from] || board.owner[from] !== player || board.dice[from] <= 1) continue;

    forEachNeighbor(board, from, to => {
      if (board.owner[to] !== player) moves.push({ from, to });
    });
  }

  return moves;
}

function findLargestConnectedGroup(board, player) {
  const visited = new Array(board.areaMax).fill(false);
  let largest = 0;

  for (let start = 1; start < board.areaMax; start++) {
    if (visited[start] || !board.exists[start] || board.owner[start] !== player) continue;

    const stack = [start];
    visited[start] = true;
    let size = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      size++;

      forEachNeighbor(board, current, next => {
        if (!visited[next] && board.owner[next] === player) {
          visited[next] = true;
          stack.push(next);
        }
      });
    }

    if (size > largest) largest = size;
  }

  return largest;
}

/*
 * Per-board memoization. Each board object is created within exactly one
 * ai_lookahead call (createBoard for the root, cloneBoard for branches) and is
 * never mutated after applyAttack finishes building it, so board identity is a
 * sound cache key: computeStats is a pure function of the board, and the AI's
 * own player is fixed for the lifetime of any given board object. Module-level
 * WeakMaps let entries be GC'd as soon as a turn's boards fall out of scope.
 */
const statsCache = new WeakMap();
const scoreCache = new WeakMap();

function computeStats(board) {
  const cached = statsCache.get(board);
  if (cached) return cached;

  const stats = Array.from({ length: board.playerSlots }, (_, id) => ({
    id,
    territories: 0,
    dice: 0,
    largestGroup: 0,
    stock: board.stock[id] || 0,
  }));

  for (let area = 1; area < board.areaMax; area++) {
    if (!board.exists[area]) continue;
    const player = board.owner[area];
    if (player < 0 || player >= board.playerSlots) continue;
    stats[player].territories++;
    stats[player].dice += board.dice[area];
  }

  /*
   * Largest connected group depends only on ownership + adjacency, never on
   * dice. When this board derives from a parent via a single attack, copy the
   * parent's group sizes and recompute only the players whose ownership changed
   * (none on a loss; the attacker and the dispossessed defender on a win). The
   * parent's stats are already cached because a board is always evaluated
   * before its children are generated. The root board recomputes every player.
   */
  const parent = board.parentBoard;
  if (parent) {
    const parentStats = computeStats(parent);
    for (const player of stats) {
      player.largestGroup = parentStats[player.id].largestGroup;
    }
    for (const id of board.changedPlayers) {
      stats[id].largestGroup = stats[id].territories > 0 ? findLargestConnectedGroup(board, id) : 0;
    }
  } else {
    for (const player of stats) {
      if (player.territories > 0) {
        player.largestGroup = findLargestConnectedGroup(board, player.id);
      }
    }
  }

  statsCache.set(board, stats);
  return stats;
}

function playerPower(player) {
  if (player.territories === 0) return 0;

  const cohesion = player.largestGroup / player.territories;
  return (
    TERRITORY_WEIGHT * player.territories +
    DICE_WEIGHT * player.dice +
    INCOME_WEIGHT * player.largestGroup +
    COHESION_WEIGHT * cohesion +
    STOCK_WEIGHT * player.stock
  );
}

function captureThreat(board, areaId, defenderDice, owner) {
  let survival = 1;

  forEachNeighbor(board, areaId, neighbor => {
    if (board.owner[neighbor] === owner || board.dice[neighbor] <= 1) return;
    survival *= 1 - winProbability(board.dice[neighbor], defenderDice);
  });

  return 1 - survival;
}

function borderThreatPenalty(board, player) {
  let penalty = 0;

  for (let area = 1; area < board.areaMax; area++) {
    if (!board.exists[area] || board.owner[area] !== player) continue;

    const threat = captureThreat(board, area, board.dice[area], player);
    if (threat > 0) {
      penalty += threat * (0.65 + 0.12 * board.dice[area]);
    }
  }

  return penalty;
}

function scoreBoard(board, player) {
  const stats = computeStats(board);
  const me = stats[player];
  if (!me || me.territories === 0) return -1000;

  const rivals = stats.filter(candidate => candidate.id !== player && candidate.territories > 0);
  if (rivals.length === 0) return 1000;

  const activePlayers = rivals.length + 1;
  const rivalPowers = rivals.map(rival => playerPower(rival));
  const strongestRivalPower = Math.max(...rivalPowers);
  const totalRivalPower = rivalPowers.reduce((sum, power) => sum + power, 0);
  const leaderWeight = activePlayers === 2 ? DUEL_LEADER_WEIGHT : LEADER_WEIGHT;

  return (
    playerPower(me) -
    leaderWeight * strongestRivalPower -
    FIELD_WEIGHT * (totalRivalPower - strongestRivalPower) -
    BORDER_THREAT_WEIGHT * borderThreatPenalty(board, player)
  );
}

function evaluateBoard(board, player) {
  const cached = scoreCache.get(board);
  if (cached !== undefined && cached.player === player) return cached.score;

  const score = scoreBoard(board, player);
  scoreCache.set(board, { player, score });
  return score;
}

function findDominantPlayer(stats) {
  const totalDice = stats.reduce((sum, player) => sum + player.dice, 0);
  if (totalDice <= 0) return -1;

  for (const player of stats) {
    if (player.dice > totalDice * DOMINANCE_SHARE) return player.id;
  }

  return -1;
}

function attackThreshold(board, player) {
  const stats = computeStats(board);
  const me = stats[player];
  /*
   * Defensive: callers only reach here for a player with territories (see the
   * early return in evaluateLookaheadTurn), but if that ever changes, fall back
   * to the patient BASE bar rather than dereferencing an undefined census row.
   */
  if (!me) return BASE_THRESHOLD;

  const activeRivals = stats.filter(
    candidate => candidate.id !== player && candidate.territories > 0
  );
  const totalDice = stats.reduce((sum, candidate) => sum + candidate.dice, 0);
  const myShare = totalDice > 0 ? me.dice / totalDice : 0;
  const bestRivalDice = Math.max(0, ...activeRivals.map(candidate => candidate.dice));

  if (myShare > PRESS_DICE_SHARE || (activeRivals.length === 1 && me.dice > bestRivalDice)) {
    return PRESS_THRESHOLD;
  }

  if (myShare < WEAK_DICE_SHARE && activeRivals.length > 1) {
    return WEAK_THRESHOLD;
  }

  return BASE_THRESHOLD;
}

function strategicAdjustment(board, player, to, winChance) {
  const stats = computeStats(board);
  const defender = board.owner[to];
  let adjustment = 0;

  if (stats[defender]?.territories === 1) {
    adjustment += ELIMINATION_BONUS * winChance;
  }

  const dominantPlayer = findDominantPlayer(stats);
  if (dominantPlayer >= 0 && dominantPlayer !== player) {
    adjustment +=
      defender === dominantPlayer
        ? LEADER_FOCUS_BONUS * winChance
        : -OFF_LEADER_PENALTY * winChance;
  }

  return adjustment;
}

function expectedMoveGain(board, player, move, depth) {
  const { from, to } = move;
  const attackerDice = board.dice[from];
  const defenderDice = board.dice[to];
  const winChance = winProbability(attackerDice, defenderDice);
  const currentScore = evaluateBoard(board, player);
  const winBoard = applyAttack(board, from, to, player, true);
  const lossBoard = applyAttack(board, from, to, player, false);

  const winContinuation = bestContinuationGain(winBoard, player, depth);
  const lossContinuation = bestContinuationGain(lossBoard, player, depth);
  const winGain = evaluateBoard(winBoard, player) - currentScore + winContinuation;
  const lossGain = evaluateBoard(lossBoard, player) - currentScore + lossContinuation;

  return (
    winChance * winGain +
    (1 - winChance) * lossGain +
    strategicAdjustment(board, player, to, winChance) -
    Math.max(0, LOW_ODDS_FLOOR - winChance) * LOW_ODDS_PENALTY
  );
}

function bestContinuationGain(board, player, depth) {
  if (depth <= 0) return 0;

  let best = 0;
  for (const move of getLegalMoves(board, player)) {
    const gain = expectedMoveGain(board, player, move, depth - 1);
    if (gain > best) best = gain;
  }

  return best;
}

function isBetterMove(score, move, bestScore, bestMove) {
  if (score > bestScore + EPSILON) return true;
  if (Math.abs(score - bestScore) > EPSILON || !bestMove) return false;
  if (move.from !== bestMove.from) return move.from < bestMove.from;
  return move.to < bestMove.to;
}

/**
 * Run the full Lookahead decision for the current turn without mutating the
 * game's chosen move. Returns the searched best move, its score, the active
 * attack threshold, and the move Lookahead would play (the best move when it
 * clears the threshold, otherwise null). Exported so the search and posture
 * logic can be tested directly; `ai_lookahead` itself is a thin wrapper that
 * applies `chosenMove`.
 *
 * @param {Object} game - Legacy mutable game view.
 * @returns {{
 *   player: number, bestMove: ?{from:number,to:number}, bestScore: number,
 *   threshold: number, chosenMove: ?{from:number,to:number}
 * }}
 */
export const evaluateLookaheadTurn = game => {
  const player = game.get_pn();
  const board = createBoard(game);

  const noMove = {
    player,
    bestMove: null,
    bestScore: -Infinity,
    threshold: BASE_THRESHOLD,
    chosenMove: null,
  };

  if (computeStats(board)[player]?.territories === 0) return noMove;

  const legalMoves = getLegalMoves(board, player);
  let bestMove = null;
  let bestScore = -Infinity;

  for (const move of legalMoves) {
    const score = expectedMoveGain(board, player, move, CONTINUATION_DEPTH);
    if (isBetterMove(score, move, bestScore, bestMove)) {
      bestScore = score;
      bestMove = move;
    }
  }

  const threshold = attackThreshold(board, player);
  const chosenMove = bestMove && bestScore > threshold ? bestMove : null;

  return { player, bestMove, bestScore, threshold, chosenMove };
};

export const ai_lookahead = game => {
  const { chosenMove } = evaluateLookaheadTurn(game);

  if (!chosenMove) return 0;

  game.area_from = chosenMove.from;
  game.area_to = chosenMove.to;
};
