/**
 * PPO self-play environment core (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * The transport-agnostic heart of the Node↔Python self-play env: one designated
 * **learner seat** plays an 8-FFA (or N-FFA) match against in-process opponent bots,
 * with the learner's per-decision action supplied by an injected synchronous
 * `chooseAction(encoded, botState) → i32` callback. Tests inject a deterministic
 * stub; `ppo-env-server.mjs` injects a blocking socket read.
 *
 * Design (per [D-19]): instead of editing the engine, we reuse `runMatch` **verbatim**
 * and inject the learner as an ordinary bot function — `runBotDirect` already calls
 * bot fns synchronously, so a bot fn that encodes-emits-and-blocks IS the integration
 * point. The other N-1 seats run through the same `runBotTurn` as any arena match.
 * Action decode mirrors the STOP-invariant + `moves[idx]` mapping in `ai_bc.js`'s `makeBC` (sans
 * its stopBias/argmax, which the env supplies as `idx`), so the env and the shipped BC bot map a
 * policy index to a move identically.
 *
 * @module scripts/lib/ppo-env
 */

import { runMatch } from '../../src/arena/matchRunner.js';
import { encodeObservationForInference } from '../../src/arena/encodeObservation.js';
import { GAME_PHASES } from '../../src/engine/constants.js';

/** Display name for the learner seat in the bots roster. */
export const LEARNER_NAME = 'ppo-learner';

/**
 * Sentinel thrown from the internal per-turn guard to unwind `runMatch` the instant the
 * learner is eliminated, when `terminateOnElimination` is set. Identity-checked on catch so a
 * genuine error from a user `onTurn` (or an `EnvClosed` from the socket) still propagates.
 * Module-level (not per-episode) to avoid an allocation per turn.
 */
const LEARNER_ELIMINATED = new Error('runSelfPlayEpisode: learner eliminated (episode terminal)');

/**
 * Decode a policy action index against the encoder's OWN `moves[]` — never a fresh
 * `getValidMoves` (the two orderings coincide today only by construction; relying on
 * the encoder's array makes a future reorder fail the parity test rather than silently
 * mis-steer). Mirrors the decode in `ai_bc.js`'s `makeBC`: the trailing edge MUST be STOP.
 *
 * @param {{moves:Array<{from:number,to:number}|null>}} encoded - `encodeObservationForInference` output.
 * @param {number} idx - chosen edge index in [0, numEdges).
 * @returns {{from:number,to:number}|null} An attack, or null for STOP (end turn).
 */
export function decodeAction(encoded, idx) {
  const n = encoded.moves.length;
  const stopIdx = n - 1;
  if (encoded.moves[stopIdx] !== null) {
    throw new Error(
      'decodeAction: trailing edge is not STOP (moves[last] !== null) — encoder layout changed.'
    );
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
    throw new Error(
      `decodeAction: action index ${idx} out of range [0, ${n}) — learner/env desync, not a recoverable move.`
    );
  }
  return encoded.moves[idx];
}

/**
 * Build the learner's bot function: a synchronous shim that encodes the live
 * observation, asks `chooseAction` for an index, and decodes it to a move.
 *
 * @param {Object} opts
 * @param {number} opts.maxAreas - node-tensor height (policy config.maxAreas).
 * @param {(encoded:Object, botState:Object) => number} opts.chooseAction - synchronous
 *   action selector; returns the chosen edge index.
 * @param {(encoded:Object, botState:Object) => void} [opts.onObservation] - optional tap
 *   fired with each encoded observation (before the choice), e.g. for trajectory capture.
 * @returns {(botState:Object) => ({from:number,to:number}|null)}
 */
export function makeLearnerBot({ maxAreas, chooseAction, onObservation } = {}) {
  if (!Number.isInteger(maxAreas) || maxAreas <= 0) {
    throw new Error(`makeLearnerBot: maxAreas must be a positive integer, got ${maxAreas}.`);
  }
  if (typeof chooseAction !== 'function') {
    throw new Error('makeLearnerBot: chooseAction must be a function.');
  }
  const ctx = { maxAreas };
  return function learnerBot(botState) {
    const encoded = encodeObservationForInference(botState, ctx);
    if (onObservation) onObservation(encoded, botState);
    const idx = chooseAction(encoded, botState);
    return decodeAction(encoded, idx);
  };
}

/**
 * Scaled placement from a 0-based finishing rank (0 = first): 1 = first … 0 = last; 0 when
 * the rank is unknown (<0) or there is a single seat. Shared by the game-over path (rank from
 * the placement order) and the early-termination path (rank = #players still alive when the
 * learner dies — see `eliminationOutcome`), so both express the identical mapping.
 *
 * @param {number} rank - 0-based finishing position, best-first; -1 if unplaced.
 * @param {number} playerCount
 * @returns {number}
 */
export function scaledPlacementFromRank(rank, playerCount) {
  return playerCount > 1 && rank >= 0 ? 1 - rank / (playerCount - 1) : 0;
}

/**
 * Scaled placement for the learner, matching `encodeStep`'s aux value target:
 * 1 = first … 0 = last; 0 when the seat is unplaced or there is a single seat.
 *
 * @param {number[]} placements - placement order, best-first.
 * @param {number} learnerSeat
 * @param {number} playerCount
 * @returns {number}
 */
export function scaledPlacement(placements, learnerSeat, playerCount) {
  return scaledPlacementFromRank(placements.indexOf(learnerSeat), playerCount);
}

/**
 * Run one self-play episode: the learner seat (`learnerSeat`) plays against the
 * given opponents and the full match is driven by `runMatch`. Returns the terminal
 * outcome relative to the learner (reward inputs for PPO).
 *
 * Opponent names are de-duplicated with `#n` suffixes (and kept distinct from the
 * learner), because `runMatch` requires unique bot names but a self-play league
 * routinely seats the same bot at several seats.
 *
 * @param {Object} cfg
 * @param {number} cfg.seed - finite numeric seed (required: training mode
 *   `recordHistory:false` makes `createGame` throw without one).
 * @param {Array<{name:string, fn:Function}>} cfg.opponents - the N-1 non-learner seats.
 * @param {number} cfg.learnerSeat - player id the learner occupies, in [0, playerCount).
 * @param {number} cfg.maxAreas - node-tensor height (policy config.maxAreas).
 * @param {(encoded:Object, botState:Object) => number} cfg.chooseAction - action selector.
 * @param {number} [cfg.maxTurns] - stalemate cap (defaults to runMatch's 500).
 * @param {(encoded:Object, botState:Object) => void} [cfg.onObservation] - per-decision tap.
 * @param {(turnCount:number, state:Object) => void} [cfg.onTurn] - per-turn tap, forwarded to
 *   `runMatch` (called before the elimination check when `terminateOnElimination` is set). A
 *   consumer can also throw from here to abort the match early.
 * @param {boolean} [cfg.terminateOnElimination=false] - end the episode the instant the LEARNER
 *   is eliminated (reward = loss), instead of playing the match out to game-over. This is the
 *   correct single-learner PPO terminal — the opponent-only tail after the learner dies is not
 *   part of the learner's MDP, and simulating it costs ~2× the wall-clock for nothing. Default
 *   off keeps the full-game result byte-identical (the integration oracle). When the learner
 *   instead survives to win/stalemate, the flag is a pure no-op.
 * @returns {{winner:number|null, won:number, placement:number, placements:number[]|null,
 *   seatBeat:(number|null)[]|null, turnCount:number, learnerSeat:number, playerCount:number,
 *   eliminated:boolean, truncated:boolean, finalState:import('../../src/engine/types.js').GameState,
 *   botStats:Object[]|null}} `seatBeat[s]` = did the learner outplace seat `s` (1/0, null at its own
 *   seat) — the league's per-opponent win-rate input ([D-22]/[D-23]). `placements`/`botStats` are null on an early elimination (the match
 *   was aborted before `runMatch` computed them); `eliminated` flags that path. `truncated` is
 *   true ONLY when the learner survived to the `maxTurns` stalemate cap (a Gym truncation — the
 *   game did not actually end, so the learner's value should be bootstrapped); a win or an
 *   elimination is a genuine terminal (`truncated:false`).
 */
export function runSelfPlayEpisode(cfg) {
  const {
    seed,
    opponents,
    learnerSeat,
    maxAreas,
    maxTurns,
    chooseAction,
    onObservation,
    onTurn,
    terminateOnElimination = false,
  } = cfg;

  if (!Number.isFinite(seed)) {
    throw new Error(
      `runSelfPlayEpisode: seed must be a finite number (training mode), got ${seed}.`
    );
  }
  if (!Array.isArray(opponents) || opponents.length === 0) {
    throw new Error('runSelfPlayEpisode: opponents must be a non-empty array.');
  }
  const playerCount = opponents.length + 1;
  if (!Number.isInteger(learnerSeat) || learnerSeat < 0 || learnerSeat >= playerCount) {
    throw new Error(
      `runSelfPlayEpisode: learnerSeat ${learnerSeat} out of range [0, ${playerCount}).`
    );
  }

  const learnerBot = makeLearnerBot({ maxAreas, chooseAction, onObservation });

  // Seat the learner at learnerSeat; opponents fill the rest in order.
  const roster = [];
  let oi = 0;
  for (let i = 0; i < playerCount; i++) {
    if (i === learnerSeat) {
      roster.push({ name: LEARNER_NAME, fn: learnerBot });
    } else {
      const opp = opponents[oi++];
      if (!opp || typeof opp.fn !== 'function') {
        throw new Error(`runSelfPlayEpisode: opponent at slot ${i} is missing a fn.`);
      }
      roster.push({ name: opp.name, fn: opp.fn });
    }
  }
  uniquifyNames(roster);

  if (terminateOnElimination) {
    /*
     * Abort the match the moment the learner is eliminated and synthesize the terminal there.
     * `runMatch`'s onTurn fires after every turn with the post-turn board, so the turn that
     * eliminates the learner (always an opponent's) triggers the unwind on its own callback.
     */
    let abortState = null;
    let abortTurn = 0;
    let abortCoElimSeats = null;
    let prevEliminated = new Set();
    const guardedOnTurn = (turnCount, state) => {
      if (onTurn) onTurn(turnCount, state);
      if (state.players[learnerSeat].eliminated) {
        /*
         * Co-eliminees: players who lost their last territory on this SAME turn as the learner.
         * `runMatch` appends simultaneous eliminations to its eliminationOrder in ascending seat-id
         * order and `calculatePlacements` reverses that, so a same-turn co-eliminee with a HIGHER
         * seat id than the learner finishes ABOVE it (a LOWER one below). Capture the whole same-turn
         * set — the seats newly eliminated this turn, learner included — so `eliminationOutcome` can
         * both correct the synthesized RANK and attribute the per-seat win/loss (`seatBeat`) exactly
         * as `calculatePlacements` would, even on a multi-elimination turn. `aliveCount` cannot see
         * these seats (they are eliminated, not alive).
         */
        const coElimSeats = new Set();
        for (const p of state.players) {
          if (p.eliminated && !prevEliminated.has(p.id)) coElimSeats.add(p.id);
        }
        abortCoElimSeats = coElimSeats;
        abortState = state;
        abortTurn = turnCount;
        throw LEARNER_ELIMINATED;
      }
      // Remember who is dead going into the next turn, so the death turn can isolate its own kills.
      prevEliminated = new Set();
      for (const p of state.players) if (p.eliminated) prevEliminated.add(p.id);
    };
    try {
      const result = runMatch({
        bots: roster,
        seed,
        maxTurns,
        recordHistory: false,
        onTurn: guardedOnTurn,
      });
      // Learner survived to game-over (won or stalemate-survivor) → identical to the full game.
      return summarizeOutcome(result, learnerSeat, playerCount);
    } catch (err) {
      // re-raise a user onTurn throw (e.g. the env-server's EnvClosed disconnect signal).
      if (err !== LEARNER_ELIMINATED) throw err;
      return eliminationOutcome(abortState, abortTurn, learnerSeat, playerCount, abortCoElimSeats);
    }
  }

  const result = runMatch({ bots: roster, seed, maxTurns, recordHistory: false, onTurn });
  return summarizeOutcome(result, learnerSeat, playerCount);
}

/**
 * Per-seat pairwise outcome vector for the league's win-rate book (ml-bot task B — [D-22]/[D-23]).
 * `seatBeat[s]` answers "did the LEARNER outplace the player at board seat `s`?" — `1` yes, `0` no,
 * `null` for the learner's own seat (and any seat the order can't rank). Strict pairwise
 * placement-relative comparison (the `elo.js` pairwise rule restricted to learner-containing pairs),
 * so the league can attribute one FFA game to one win/loss record per opponent seat. Built from the
 * authoritative placement order (best-first list of seat ids); a total order means no `0.5` ties in
 * practice, but the rule is kept defensively. Index = board seat (`state.players[i].id === i`).
 *
 * @param {number[]} placements - placement order, best-first (seat ids); `placements.indexOf(seat)` = rank.
 * @param {number} learnerSeat
 * @param {number} playerCount
 * @returns {(number|null)[]} length `playerCount`, indexed by seat.
 */
function seatBeatFromPlacements(placements, learnerSeat, playerCount) {
  const rank = new Array(playerCount).fill(-1);
  placements.forEach((seat, i) => {
    rank[seat] = i;
  });
  const learnerRank = rank[learnerSeat];
  return Array.from({ length: playerCount }, (_, seat) => {
    if (seat === learnerSeat) return null;
    const r = rank[seat];
    if (r < 0 || learnerRank < 0) return null; // seat absent from the order — unrankable
    if (learnerRank < r) return 1; // learner placed higher (lower index) → beat seat
    if (learnerRank > r) return 0;
    return 0.5; // exact tie — unreachable for a strict placement order, kept for elo parity
  });
}

/**
 * Shape a completed-match `runMatch` result into the episode outcome (learner's reward inputs).
 *
 * @param {import('../../src/arena/matchRunner.js').MatchResult} result
 * @param {number} learnerSeat
 * @param {number} playerCount
 */
function summarizeOutcome(result, learnerSeat, playerCount) {
  return {
    winner: result.winner,
    won: result.winner === learnerSeat ? 1 : 0,
    placement: scaledPlacement(result.placements, learnerSeat, playerCount),
    placements: result.placements,
    /*
     * Per-seat pairwise win/loss for the league's win-rate book ([D-22] decision 5). The completed-
     * match path has the full placement order, so derive it directly. `recordResult` excludes
     * `maxTurns` truncations from the book, so the value on a stalemate is computed-but-unused.
     */
    seatBeat: Array.isArray(result.placements)
      ? seatBeatFromPlacements(result.placements, learnerSeat, playerCount)
      : null,
    turnCount: result.turnCount,
    learnerSeat,
    playerCount,
    eliminated: false,
    /*
     * The learner reached game end alive. If the engine never declared a winner
     * (phase !== GAME_OVER), the match stopped on the `maxTurns` cap — a Gym
     * truncation (bootstrap V(s)), not a genuine terminal. A real win/loss is GAME_OVER.
     */
    truncated: result.finalState.phase !== GAME_PHASES.GAME_OVER,
    finalState: result.finalState,
    botStats: result.botStats,
  };
}

/**
 * Synthesize the learner's terminal outcome at the moment of its elimination (early-termination
 * mode), without simulating the opponent-only tail. The learner's FINAL rank is fixed once it
 * dies: every player still alive outlives it (better placement) and every player eliminated on a
 * PRIOR turn finished below it. So the base rank is `#players still alive` (`aliveCount`), plus a
 * correction for same-turn co-eliminees that outrank the learner: `runMatch` orders simultaneous
 * eliminations by ascending seat id and `calculatePlacements` reverses that, so a co-eliminee with
 * a higher seat id than the learner places above it (`coElimAbove`, derived here from `coElimSeats`).
 * `aliveCount + coElimAbove` reproduces `calculatePlacements`' game-over rank exactly, with no tail
 * simulated. `winner` is the engine's winner when the eliminating turn also ended the game (learner
 * = runner-up), else null (game still undecided); the reward is `won = 0` either way.
 * `placements`/`botStats` are null — the match was aborted before `runMatch` built them.
 *
 * The same `coElimSeats` set also yields the per-seat win-rate vector (`seatBeat`) without the tail:
 * every still-alive seat outlives the learner (`0`); a same-turn co-eliminee is split by the seat-id
 * tie-break (higher id placed above → `0`, lower id below → `1`); every prior-turn elimination was
 * outlived by the learner (`1`). This reproduces `seatBeatFromPlacements` over the never-built
 * game-over placements exactly, preserving the ~2× early-termination throughput.
 *
 * @param {import('../../src/engine/types.js').GameState} state - board at the learner's elimination.
 * @param {number} turnCount - turns played when the learner was eliminated.
 * @param {number} learnerSeat
 * @param {number} playerCount
 * @param {Set<number>|null} [coElimSeats=null] - seats eliminated on the learner's death turn
 *   (learner included); same-turn co-eliminees with a higher seat id than the learner outrank it.
 */
function eliminationOutcome(state, turnCount, learnerSeat, playerCount, coElimSeats = null) {
  const aliveCount = state.players.filter(p => !p.eliminated).length; // players who outlive the learner
  const coElim = coElimSeats ?? new Set();
  // Same-turn co-eliminees with a higher seat id than the learner finish ABOVE it (the rank correction).
  let coElimAbove = 0;
  for (const id of coElim) if (id > learnerSeat) coElimAbove++;
  return {
    winner: state.winner,
    won: 0,
    placement: scaledPlacementFromRank(aliveCount + coElimAbove, playerCount),
    placements: null,
    /*
     * Per-seat pairwise win/loss synthesized at the learner's death — no game-over placements exist,
     * but this matches what `seatBeatFromPlacements` would return for the full game (see doc above).
     */
    seatBeat: state.players.map(p => {
      if (p.id === learnerSeat) return null;
      if (!p.eliminated) return 0; // alive → outlives the learner → learner did NOT beat it
      if (coElim.has(p.id)) return p.id > learnerSeat ? 0 : 1; // same-turn tie-break by seat id
      return 1; // eliminated on a prior turn → the learner outlived it
    }),
    turnCount,
    learnerSeat,
    playerCount,
    eliminated: true,
    /*
     * The learner's elimination is a genuine MDP terminal (a loss), never a cap truncation —
     * even if it happens to coincide with the maxTurns boundary, the learner's episode ended
     * because it died, so its value bootstrap is 0.
     */
    truncated: false,
    finalState: state,
    botStats: null,
  };
}

/**
 * Suffix duplicate roster names in place with `#2`, `#3`, … so `runMatch`'s
 * unique-name requirement holds even when the league seats the same opponent
 * multiple times. The first occurrence keeps its bare name.
 *
 * @param {Array<{name:string}>} roster
 */
function uniquifyNames(roster) {
  const seen = new Map();
  for (const bot of roster) {
    const count = seen.get(bot.name) || 0;
    seen.set(bot.name, count + 1);
    if (count > 0) bot.name = `${bot.name}#${count + 1}`;
  }
}
