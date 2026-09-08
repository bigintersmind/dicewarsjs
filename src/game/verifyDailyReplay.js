/**
 * Daily Conquest replay verifier.
 *
 * Server-side truth for a submitted daily result. Pure: no I/O, no DOM, no
 * timers, no globals beyond the engine — so the same function runs in Node
 * (tests, CLI) and inside the Cloudflare Worker that backs the shared
 * leaderboard (`server/daily-leaderboard/`).
 *
 * The contract it enforces is "this replay is a game that was really played on
 * today's board". Nothing the client claims is trusted:
 *
 * 1. **Board** — the replay's engine config must equal the config the
 *    controller would have built for that UTC date's `createDailyChallenge`
 *    (4 seats, Small, fair dice). A different seed, size or handicap is
 *    `wrong_board`, not a low score.
 * 2. **Human actions** — replayed through the real `applyAction`. The engine's
 *    own validation is the rule; a move it refuses is `unverifiable`.
 * 3. **AI actions** — *not* replayed. The verifier runs `ai_default` itself,
 *    move by move, exactly the way `GameController.runAITurn` does, and
 *    requires the replay's recorded action to be the one it computed. A
 *    hand-edited opponent turn (the cheapest way to fake a fast win) diverges
 *    on the first altered action.
 * 4. **Score** — derived from the re-simulation with the same
 *    `createMatchJournal`/`recordMatchStep`/`finishMatchJournal` the browser
 *    uses, so the verified `turns`/`attacks`/`captures` are the numbers the
 *    player actually saw. `replay.metadata` is never read.
 *
 * End conditions mirror the browser game exactly (see `GameController`):
 * total conquest (`phase === GAME_OVER`), the human's elimination mid-game
 * (the journal freezes there; the replay may legitimately continue with
 * spectated AI turns, which are still verified), and the {@link MAX_GAME_TURNS}
 * turn-cap draw (issue #114). A replay that reaches none of them is
 * `not_finished` — an abandoned game, not a result.
 *
 * @module game/verifyDailyReplay
 */

import { createGame } from '../engine/GameRunner.js';
import { applyAction, getValidMoves } from '../engine/StateManager.js';
import { ACTION_TYPES, GAME_PHASES } from '../engine/constants.js';
import { runAI } from '../engine/AIAdapter.js';
import { ai_default } from '../ai/ai_default.js';
import { SUPPORTED_REPLAY_VERSIONS } from '../arena/replayFormat.js';
import { resolveMapSize } from '../utils/config.js';
import { createDailyChallenge } from './dailyChallenge.js';
import { createMatchJournal, recordMatchStep, finishMatchJournal } from './matchJournal.js';

/** Seat the human always plays in a daily game (`aiAssignments[0] === null`). */
export const HUMAN_SEAT = 0;

/**
 * Turn-cap draw threshold, in completed player-turns — the mirror of
 * `GameController`'s exported `MAX_GAME_TURNS` (issue #114). Duplicated rather
 * than imported because the controller drags the renderer, store and community
 * bot loader in with it, none of which can be bundled into a Worker. The
 * integration test asserts the two constants are equal, so the copy can't drift
 * silently.
 */
export const MAX_GAME_TURNS = 300;

/** Safety cap on moves in one AI turn — `GameController.runAITurn`'s `maxMoves`. */
const MAX_MOVES_PER_TURN = 100;

/** Consecutive invalid AI moves before its turn is force-ended (controller rule). */
const MAX_CONSECUTIVE_INVALID = 3;

/**
 * Hard bound on how long a submitted replay may be, checked before a single
 * action is simulated. It exists so a hostile submission can't buy unbounded
 * CPU on a request that is going to be rejected anyway.
 *
 * Where 3,000 comes from, and why not the arithmetic ceiling: the literal
 * product of the {@link MAX_GAME_TURNS} cap and {@link MAX_MOVES_PER_TURN}
 * (300 × 101 ≈ 30,300) is not a useful bound — it is *larger* than the 20,000
 * this replaces, and no board can produce it. A turn's attacks are really
 * bounded by the dice on the board (every attack, won or lost, removes at least
 * one), and the measured worst case is a 215-turn game of 840 actions, under
 * four per turn. Ten per turn across the full 300-turn cap is 3,000: three
 * times the rate any real game sustains, and still an order of magnitude below
 * the old ceiling.
 *
 * In the Worker this is the belt to the 32 KB body cap's braces (`MAX_BODY_BYTES`
 * in `server/daily-leaderboard/src/index.js`) — that much JSON cannot hold much
 * more than a thousand attack actions — so it should never be the thing that
 * refuses an honest submission.
 */
export const MAX_REPLAY_ACTIONS = 3000;

/**
 * Engine config fields a daily replay must reproduce exactly. These are the
 * fields `createReplayFromActions` whitelists, minus `handicap` (checked
 * separately so its failure gets its own message).
 */
export const BOARD_FIELDS = [
  'seed',
  'playerCount',
  'mapWidth',
  'mapHeight',
  'maxAreas',
  'dicePerArea',
];

/**
 * What `take()` returns once the replay's actions are used up.
 *
 * A dedicated sentinel, not `null`: the actions come from parsed JSON, so a
 * submitted `null` in the list is entirely possible, and confusing it with the
 * end of the replay would report a tampered file as a merely abandoned one.
 */
const END_OF_REPLAY = Symbol('end of replay');

/**
 * @typedef {Object} VerifiedResult
 * @property {true}    ok
 * @property {boolean} won      - Human conquered the board
 * @property {boolean} drew     - Game ended on the turn cap with nobody eliminated out
 * @property {number}  turns    - Human turns, as the journal counts them
 * @property {number}  attacks  - Human attacks resolved
 * @property {number}  captures - Human attacks that took a territory
 */

/**
 * @typedef {Object} RejectedResult
 * @property {false}  ok
 * @property {'wrong_board'|'unverifiable'|'not_finished'} code
 * @property {string} message - Player-readable reason
 */

/** @returns {RejectedResult} */
function reject(code, message) {
  return { ok: false, code, message };
}

/**
 * Verify a submitted Daily Conquest replay against a UTC board date.
 *
 * Never throws: malformed input, a torn replay and an engine refusal all come
 * back as a `{ ok: false }` result, because every caller is a request handler
 * that has to answer with a code either way.
 *
 * @param {string} date - Board date, `YYYY-MM-DD` UTC
 * @param {Object} replay - Replay v1/v2 object (`{ version, config, actions }`)
 * @param {Object} [options]
 * @param {number} [options.maxTurns=MAX_GAME_TURNS] - Turn-cap override, clamped
 *   to {@link MAX_GAME_TURNS}: it can only LOWER the cap, never raise it past
 *   the browser's. Tests only: a real daily game between `ai_default` bots
 *   resolves long before 300 player-turns, so the draw branch is otherwise
 *   unreachable from a genuine replay. Production callers must leave it at the
 *   default or they are not verifying against the game the player played.
 * @returns {VerifiedResult|RejectedResult}
 */
export function verifyDailyReplay(date, replay, options = {}) {
  try {
    return runVerification(date, replay, options);
  } catch (err) {
    /*
     * Everything below is engine code driven by attacker-controlled input, so a
     * throw is a rejection, not a 500: applyAction refuses illegal moves by
     * throwing, and a torn replay object can trip a property read anywhere. The
     * message is included because it is the only diagnostic a submitter gets.
     */
    return reject('unverifiable', `Replay could not be verified: ${err.message}`);
  }
}

/** @returns {VerifiedResult|RejectedResult} */
function runVerification(date, replay, options) {
  const maxTurns = Math.min(options.maxTurns ?? MAX_GAME_TURNS, MAX_GAME_TURNS);

  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) {
    return reject('unverifiable', 'Replay is missing or is not an object.');
  }
  if (!SUPPORTED_REPLAY_VERSIONS.includes(replay.version)) {
    return reject(
      'wrong_board',
      `Unsupported replay version ${JSON.stringify(replay.version)}; this build reads ${SUPPORTED_REPLAY_VERSIONS.join(', ')}.`
    );
  }
  if (!replay.config || typeof replay.config !== 'object' || Array.isArray(replay.config)) {
    return reject('unverifiable', 'Replay is missing its game config.');
  }
  if (!Array.isArray(replay.actions)) {
    return reject('unverifiable', 'Replay is missing its action list.');
  }
  if (replay.actions.length > MAX_REPLAY_ACTIONS) {
    return reject(
      'unverifiable',
      `Replay is too long: ${replay.actions.length} actions (limit ${MAX_REPLAY_ACTIONS}).`
    );
  }

  let challenge;
  try {
    challenge = createDailyChallenge(date);
  } catch (err) {
    return reject('wrong_board', err.message);
  }

  /*
   * Everything below hard-codes v1's recipe: the human in HUMAN_SEAT, ai_default
   * in every other seat, standard difficulty and fair dice. Edit the recipe
   * without teaching the verifier the new one and every honest submission gets
   * re-simulated against the wrong opponents and rejected as a forgery — the one
   * failure mode nobody would see in the logs. So say so instead: the throw is
   * caught by verifyDailyReplay and answered as `unverifiable`, which is the
   * truth (this server cannot verify that board), and the message names the fix.
   */
  const seats = challenge.aiAssignments;
  if (
    !Array.isArray(seats) ||
    seats.length !== challenge.playerCount ||
    seats[HUMAN_SEAT] !== null ||
    seats.some((bot, seat) => seat !== HUMAN_SEAT && bot !== 'ai_default') ||
    challenge.difficulty !== 'standard' ||
    challenge.luck !== 0
  ) {
    throw new Error(
      `the daily recipe changed (${JSON.stringify({
        aiAssignments: seats,
        difficulty: challenge.difficulty,
        luck: challenge.luck,
      })}); verifyDailyReplay hard-codes seat ${HUMAN_SEAT} + ai_default on fair dice and must be updated to match`
    );
  }

  /*
   * The board the client should have been given, rebuilt the way
   * GameController.startNewGame builds it for a daily: the challenge's seat
   * count and map-size preset, and no handicap (a daily is always fair dice).
   * createGame resolves the remaining defaults, so `reference.config` is the
   * full config a legitimate replay's whitelist was copied from.
   */
  const reference = createGame({
    playerCount: challenge.playerCount,
    ...resolveMapSize(challenge.mapSize),
    handicap: null,
    seed: challenge.seed,
  });

  for (const field of BOARD_FIELDS) {
    if (replay.config[field] !== reference.config[field]) {
      return reject(
        'wrong_board',
        `Replay is from a different board: ${field} is ${JSON.stringify(replay.config[field])}, ` +
          `expected ${JSON.stringify(reference.config[field])} for ${date}.`
      );
    }
  }
  if ((replay.config.handicap ?? null) !== null) {
    return reject(
      'wrong_board',
      'Daily Conquest is played on fair dice; this replay is handicapped.'
    );
  }

  return simulate(reference, replay.actions, maxTurns);
}

/**
 * Re-play the recorded actions against a freshly generated board.
 *
 * @param {import('../engine/types.js').GameState} initialState
 * @param {{type: string, from?: number, to?: number}[]} actions
 * @param {number} maxTurns
 * @returns {VerifiedResult|RejectedResult}
 */
function simulate(initialState, actions, maxTurns) {
  let state = initialState;
  let journal = createMatchJournal(state, HUMAN_SEAT);
  if (!journal) return reject('wrong_board', `Board has no seat ${HUMAN_SEAT} to verify.`);

  /** Cursor into `actions`; `exhausted` latches when the replay runs out. */
  let index = 0;
  let exhausted = false;
  const take = () => {
    if (index >= actions.length) {
      exhausted = true;
      return END_OF_REPLAY;
    }
    return actions[index++];
  };

  /**
   * The client's result, latched at the FIRST end condition it hit. An
   * elimination followed by spectating to the turn cap is a loss on the
   * player's card, not a draw — the journal froze at the elimination and
   * `finishMatchJournal` is a no-op afterwards, exactly as in the browser.
   */
  let ended = false;
  let drew = false;
  /**
   * Close the journal at the first end condition, and hand the closed one back.
   *
   * It takes the journal to close because an elimination lands *inside* an AI
   * turn, whose local journal is still open and has not been handed up to this
   * scope yet: closing the stale outer one there would be undone the moment the
   * turn returns. The caller adopts the return value; the outer `journal` is set
   * either way, so the simulate-scope callers can ignore it.
   */
  const endHere = (st, isDraw, openJournal = journal) => {
    if (ended) return openJournal;
    journal = finishMatchJournal(openJournal, st);
    drew = isDraw;
    ended = true;
    return journal;
  };

  /** @returns {VerifiedResult|RejectedResult} */
  const settle = () => {
    if (!ended) {
      return reject(
        'not_finished',
        'Replay stops before the game ended — an abandoned attempt is not a result.'
      );
    }
    if (index < actions.length) {
      return reject(
        'unverifiable',
        `Replay carries ${actions.length - index} extra action(s) after the game ended.`
      );
    }
    return {
      ok: true,
      won: journal.won === true,
      drew,
      turns: journal.turns,
      attacks: journal.attacks,
      captures: journal.captures,
    };
  };

  const humanKnockedOut = st =>
    st.players[HUMAN_SEAT]?.eliminated === true && st.phase !== GAME_PHASES.GAME_OVER;

  /*
   * One iteration = one player-turn. Bounded by the action budget rather than
   * the turn cap: a spectated game runs past no bound the cap sets, and every
   * turn consumes at least the one END_TURN action, so the replay's length is
   * the honest bound on how many turns there can be.
   */
  for (let guard = 0; guard <= actions.length; guard++) {
    if (state.phase === GAME_PHASES.GAME_OVER) return settle();

    const seat = state.turnOrder[state.currentPlayerIndex];
    const outcome =
      seat === HUMAN_SEAT
        ? playHumanTurn(state, take, journal)
        : playAITurn(state, take, journal, humanKnockedOut, endHere);

    if (outcome.rejected) return outcome.rejected;
    state = outcome.state;
    journal = outcome.journal;
    if (exhausted) return settle();
    if (outcome.gameOver) {
      endHere(state, false);
      return settle();
    }
    if (outcome.turnEnded && state.turnsTaken >= maxTurns) {
      endHere(state, true);
      return settle();
    }
  }

  /*
   * Unreachable for a well-formed replay (the loop consumes an action per turn),
   * so reaching it means the actions ran out without `exhausted` latching.
   */
  return settle();
}

/**
 * Replay one human turn: the recorded actions are the player's own decisions,
 * so they are applied as recorded and only the engine judges them. Mirrors
 * `GameController.executeAttack` (which likewise lets `applyAction` be the
 * rule) followed by `endTurn`.
 *
 * @returns {{state, journal, gameOver?: boolean, turnEnded?: boolean, rejected?: RejectedResult}}
 */
function playHumanTurn(state, take, journal) {
  let current = state;
  let log = journal;

  for (;;) {
    const recorded = take();
    if (recorded === END_OF_REPLAY) return { state: current, journal: log };
    if (!recorded || typeof recorded !== 'object') {
      return {
        state: current,
        journal: log,
        rejected: reject('unverifiable', 'Malformed action.'),
      };
    }

    if (recorded.type === ACTION_TYPES.END_TURN) {
      const before = current;
      current = applyAction(current, { type: ACTION_TYPES.END_TURN });
      log = recordMatchStep(log, before, current);
      return { state: current, journal: log, turnEnded: true };
    }

    if (recorded.type !== ACTION_TYPES.ATTACK) {
      return {
        state: current,
        journal: log,
        rejected: reject('unverifiable', `Unknown action type ${JSON.stringify(recorded.type)}.`),
      };
    }

    const before = current;
    try {
      current = applyAction(current, {
        type: ACTION_TYPES.ATTACK,
        from: recorded.from,
        to: recorded.to,
      });
    } catch (err) {
      return {
        state: current,
        journal: log,
        rejected: reject('unverifiable', `Illegal move in the replay: ${err.message}`),
      };
    }
    log = recordMatchStep(log, before, current);

    if (current.phase === GAME_PHASES.GAME_OVER) {
      return { state: current, journal: log, gameOver: true };
    }
  }
}

/**
 * Re-derive one AI turn and check the replay against it.
 *
 * A near-transcription of `GameController.runAITurn`, including the parts that
 * look redundant: the 100-move ceiling, the three-consecutive-invalid rule (the
 * controller retries the same state, so a deterministic bot simply burns three
 * iterations before the turn ends), and the mid-turn human-elimination check
 * that freezes the journal without ending the turn.
 *
 * The one deliberate difference: the controller *returns* at the elimination
 * and only resumes this seat's loop if the player presses SPECTATE — which
 * resets its move counter. This keeps going, so a spectated turn that would
 * have had two move budgets here gets one. Only reachable for a turn longer
 * than 100 moves, which no `ai_default` turn on a 20-territory board is.
 *
 * @returns {{state, journal, gameOver?: boolean, turnEnded?: boolean, rejected?: RejectedResult}}
 */
function playAITurn(state, take, journal, humanKnockedOut, endHere) {
  let current = state;
  let log = journal;
  let invalidCount = 0;

  for (let i = 0; i < MAX_MOVES_PER_TURN; i++) {
    if (current.phase === GAME_PHASES.GAME_OVER) break;

    const move = runAI(current, ai_default);
    if (!move) break; // the bot ends its own turn

    const isValid = getValidMoves(current).some(m => m.from === move.from && m.to === move.to);
    if (!isValid) {
      invalidCount++;
      if (invalidCount >= MAX_CONSECUTIVE_INVALID) break;
      continue;
    }

    const recorded = take();
    if (recorded === END_OF_REPLAY) return { state: current, journal: log };
    if (
      !recorded ||
      recorded.type !== ACTION_TYPES.ATTACK ||
      recorded.from !== move.from ||
      recorded.to !== move.to
    ) {
      return {
        state: current,
        journal: log,
        rejected: reject(
          'unverifiable',
          `Opponent move ${JSON.stringify(recorded)} does not match the move ` +
            `${JSON.stringify({ type: ACTION_TYPES.ATTACK, ...move })} this board produces.`
        ),
      };
    }

    const before = current;
    current = applyAction(current, {
      type: ACTION_TYPES.ATTACK,
      from: move.from,
      to: move.to,
    });
    invalidCount = 0;
    log = recordMatchStep(log, before, current);

    /*
     * The browser freezes the player's card here and shows game over; the game
     * itself keeps running for the surviving bots, and the replay only carries
     * on if the player chose to spectate. Either way the journal is done.
     */
    if (humanKnockedOut(current)) log = endHere(current, false, log);

    if (current.phase === GAME_PHASES.GAME_OVER) {
      return { state: current, journal: log, gameOver: true };
    }
  }

  if (current.phase === GAME_PHASES.GAME_OVER) {
    return { state: current, journal: log, gameOver: true };
  }

  const recorded = take();
  if (recorded === END_OF_REPLAY) return { state: current, journal: log };
  if (!recorded || recorded.type !== ACTION_TYPES.END_TURN) {
    return {
      state: current,
      journal: log,
      rejected: reject(
        'unverifiable',
        `Expected the opponent's turn to end here, found ${JSON.stringify(recorded)}.`
      ),
    };
  }

  const before = current;
  current = applyAction(current, { type: ACTION_TYPES.END_TURN });
  log = recordMatchStep(log, before, current);
  return { state: current, journal: log, turnEnded: true };
}
