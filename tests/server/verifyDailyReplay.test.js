/**
 * The verifier, checked against games the real controller actually played.
 *
 * The integration half is the load-bearing one: a synthetic replay could agree
 * with `verifyDailyReplay` and still disagree with the browser, which is the
 * only failure that matters here. So every fixture comes out of a headless
 * `GameController` run — real engine, real `ai_default` opponents — and the
 * assertion is that the verifier reproduces that game's frozen `matchJournal`
 * field for field.
 */

import {
  verifyDailyReplay,
  MAX_GAME_TURNS,
  MAX_REPLAY_ACTIONS,
} from '../../src/game/verifyDailyReplay.js';
import { MAX_GAME_TURNS as CONTROLLER_MAX_GAME_TURNS } from '../../src/controller/GameController.js';
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction } from '../../src/engine/StateManager.js';
import { GAME_PHASES } from '../../src/engine/constants.js';
import { createDailyChallenge } from '../../src/game/dailyChallenge.js';
import { playDailyGame, greedyHuman, cautiousHuman, timidHuman } from './dailyReplayFixture.js';

/**
 * One date carries the whole integration matrix: greedy wins it, cautious wins
 * it more slowly, timid loses it. Same seed, same opponents, three outcomes.
 */
const BOARD = '2026-09-16';

/** A date where greedy play gets the human knocked out mid-game. */
const ELIMINATION_BOARD = '2026-09-03';

/** Replay the recorded actions, reporting the seat that acted on each one. */
function seatsPerAction(replay) {
  let state = createGame(replay.config);
  return replay.actions.map(action => {
    const seat = state.turnOrder[state.currentPlayerIndex];
    state = applyAction(state, action.type === 'ATTACK' ? action : { type: 'END_TURN' });
    return seat;
  });
}

/** Index just past the action that knocked the human out (or -1). */
function eliminationCut(replay) {
  let state = createGame(replay.config);
  for (const [i, action] of replay.actions.entries()) {
    state = applyAction(state, action.type === 'ATTACK' ? action : { type: 'END_TURN' });
    if (state.players[0].eliminated && state.phase !== GAME_PHASES.GAME_OVER) return i + 1;
  }
  return -1;
}

/** Index just past the END_TURN that took the game to `cap` completed turns. */
function turnCapCut(replay, cap) {
  let state = createGame(replay.config);
  for (const [i, action] of replay.actions.entries()) {
    state = applyAction(state, action.type === 'ATTACK' ? action : { type: 'END_TURN' });
    if (state.turnsTaken >= cap) return i + 1;
  }
  return -1;
}

/** The journal fields the leaderboard is built out of. */
function scoreOf(journal) {
  return {
    won: journal.won,
    turns: journal.turns,
    attacks: journal.attacks,
    captures: journal.captures,
  };
}

let win;
let slowWin;
let loss;
let elimination;

beforeAll(async () => {
  win = await playDailyGame({ date: BOARD, human: greedyHuman });
  slowWin = await playDailyGame({ date: BOARD, human: cautiousHuman });
  loss = await playDailyGame({ date: BOARD, human: timidHuman });
  elimination = await playDailyGame({
    date: ELIMINATION_BOARD,
    human: greedyHuman,
    spectateToEnd: true,
  });
}, 120000);

describe('verifyDailyReplay against real controller games', () => {
  it('the fixtures really are three different outcomes on one board', () => {
    expect(win.journal.won).toBe(true);
    expect(slowWin.journal.won).toBe(true);
    expect(slowWin.journal.turns).toBeGreaterThan(win.journal.turns);
    expect(loss.journal.won).toBe(false);
    for (const game of [win, slowWin, loss]) {
      expect(game.screen).toBe('gameOver');
      expect(game.replay.config.seed).toBe(createDailyChallenge(BOARD).seed);
    }
  });

  it('reproduces a win exactly as the player saw it', () => {
    expect(verifyDailyReplay(BOARD, win.replay)).toEqual({
      ok: true,
      drew: false,
      ...scoreOf(win.journal),
    });
  });

  it('reproduces a slower win on the same board', () => {
    expect(verifyDailyReplay(BOARD, slowWin.replay)).toEqual({
      ok: true,
      drew: false,
      ...scoreOf(slowWin.journal),
    });
  });

  it('accepts a loss and reports it as one', () => {
    const verdict = verifyDailyReplay(BOARD, loss.replay);
    expect(verdict).toEqual({ ok: true, drew: false, ...scoreOf(loss.journal) });
    expect(verdict.won).toBe(false);
  });

  it('keeps the frozen turn count when the player spectated past their elimination', () => {
    expect(elimination.humanEliminated || elimination.journal.finished).toBe(true);
    const verdict = verifyDailyReplay(ELIMINATION_BOARD, elimination.replay);
    expect(verdict).toEqual({ ok: true, drew: false, ...scoreOf(elimination.journal) });
    // The spectated tail is real play, so the replay is much longer than the
    // human's own game — the point being that it does not inflate the score.
    expect(elimination.replay.actions.length).toBeGreaterThan(eliminationCut(elimination.replay));
  });

  it('scores the same game the same way when the replay stops at the elimination', () => {
    const cut = eliminationCut(elimination.replay);
    expect(cut).toBeGreaterThan(0);
    const truncated = {
      ...elimination.replay,
      actions: elimination.replay.actions.slice(0, cut),
    };
    expect(verifyDailyReplay(ELIMINATION_BOARD, truncated)).toEqual({
      ok: true,
      drew: false,
      ...scoreOf(elimination.journal),
    });
  });

  it('calls a game that stops on the turn cap a draw', () => {
    /*
     * A real daily between ai_default bots is decided long before 300
     * player-turns, so the cap is reached here with the documented test-only
     * override, on a genuine replay cut at exactly the action the browser would
     * have stopped on.
     */
    const cap = 12;
    const cut = turnCapCut(win.replay, cap);
    const stalled = { ...win.replay, actions: win.replay.actions.slice(0, cut) };

    const verdict = verifyDailyReplay(BOARD, stalled, { maxTurns: cap });
    expect(verdict.ok).toBe(true);
    expect(verdict).toMatchObject({ won: false, drew: true });

    // The same replay under the real cap is simply an abandoned game.
    expect(verifyDailyReplay(BOARD, stalled)).toMatchObject({ ok: false, code: 'not_finished' });
  });

  it('uses the same turn cap the browser game does', () => {
    expect(MAX_GAME_TURNS).toBe(CONTROLLER_MAX_GAME_TURNS);
  });
});

describe('verifyDailyReplay rejects tampering', () => {
  it('catches an edited opponent move', () => {
    const seats = seatsPerAction(win.replay);
    const index = seats.findIndex(
      (seat, i) => seat !== 0 && win.replay.actions[i].type === 'ATTACK'
    );
    expect(index).toBeGreaterThanOrEqual(0);

    const actions = win.replay.actions.map((action, i) =>
      i === index ? { ...action, to: action.from } : action
    );
    const verdict = verifyDailyReplay(BOARD, { ...win.replay, actions });
    expect(verdict).toMatchObject({ ok: false, code: 'unverifiable' });
    expect(verdict.message).toMatch(/does not match/i);
  });

  it('catches an opponent turn that was ended early', () => {
    const seats = seatsPerAction(win.replay);
    const index = seats.findIndex(
      (seat, i) => seat !== 0 && win.replay.actions[i].type === 'ATTACK'
    );
    const actions = win.replay.actions.map((action, i) =>
      i === index ? { type: 'END_TURN' } : action
    );
    expect(verifyDailyReplay(BOARD, { ...win.replay, actions })).toMatchObject({
      ok: false,
      code: 'unverifiable',
    });
  });

  it('catches an illegal human attack spliced into the replay', () => {
    const seats = seatsPerAction(win.replay);
    const index = seats.findIndex(
      (seat, i) => seat === 0 && win.replay.actions[i].type === 'ATTACK'
    );
    expect(index).toBeGreaterThanOrEqual(0);

    // Attacking your own territory: refused by the engine, not by a rule the
    // verifier invented.
    const selfAttack = { ...win.replay.actions[index], to: win.replay.actions[index].from };
    const actions = win.replay.actions.map((action, i) => (i === index ? selfAttack : action));
    expect(verifyDailyReplay(BOARD, { ...win.replay, actions })).toMatchObject({
      ok: false,
      code: 'unverifiable',
    });
  });

  it('catches a human attack from a territory that does not exist', () => {
    const seats = seatsPerAction(win.replay);
    const index = seats.findIndex(
      (seat, i) => seat === 0 && win.replay.actions[i].type === 'ATTACK'
    );
    const actions = [...win.replay.actions];
    actions.splice(index, 0, { type: 'ATTACK', from: 9999, to: 9998 });
    expect(verifyDailyReplay(BOARD, { ...win.replay, actions })).toMatchObject({
      ok: false,
      code: 'unverifiable',
    });
  });

  it('rejects a replay from another board', () => {
    const other = createDailyChallenge('2026-09-13');
    const forged = { ...win.replay, config: { ...win.replay.config, seed: other.seed } };
    const verdict = verifyDailyReplay(BOARD, forged);
    expect(verdict).toMatchObject({ ok: false, code: 'wrong_board' });
    expect(verdict.message).toMatch(/seed/);
  });

  it('rejects a resized board', () => {
    const forged = { ...win.replay, config: { ...win.replay.config, maxAreas: 48 } };
    expect(verifyDailyReplay(BOARD, forged)).toMatchObject({ ok: false, code: 'wrong_board' });
  });

  it('rejects a replay played with a luck handicap', () => {
    const forged = {
      ...win.replay,
      config: { ...win.replay.config, handicap: { playerId: 0, level: 2 } },
    };
    const verdict = verifyDailyReplay(BOARD, forged);
    expect(verdict).toMatchObject({ ok: false, code: 'wrong_board' });
    expect(verdict.message).toMatch(/fair dice/i);
  });

  it('rejects an unreadable replay version', () => {
    expect(verifyDailyReplay(BOARD, { ...win.replay, version: 99 })).toMatchObject({
      ok: false,
      code: 'wrong_board',
    });
  });

  it('rejects a replay submitted for a date that has no board', () => {
    expect(verifyDailyReplay('2026-13-45', win.replay)).toMatchObject({
      ok: false,
      code: 'wrong_board',
    });
  });

  it('ignores everything the metadata claims', () => {
    const truth = verifyDailyReplay(BOARD, win.replay);
    const lied = verifyDailyReplay(BOARD, {
      ...win.replay,
      metadata: {
        bots: ['cheater'],
        winner: 3,
        turnCount: 1,
        turns: 1,
        won: false,
        timestamp: '1999-01-01T00:00:00.000Z',
      },
    });
    expect(lied).toEqual(truth);
    expect(lied.turns).toBe(win.journal.turns);
  });

  it('rejects a game that was walked away from', () => {
    const abandoned = { ...win.replay, actions: win.replay.actions.slice(0, 10) };
    expect(verifyDailyReplay(BOARD, abandoned)).toMatchObject({
      ok: false,
      code: 'not_finished',
    });
  });

  it('rejects actions appended after the game was already over', () => {
    const padded = {
      ...win.replay,
      actions: [...win.replay.actions, { type: 'END_TURN' }],
    };
    const verdict = verifyDailyReplay(BOARD, padded);
    expect(verdict).toMatchObject({ ok: false, code: 'unverifiable' });
    expect(verdict.message).toMatch(/after the game ended/);
  });

  it('bounds the action budget above any real game and far below the old ceiling', () => {
    /*
     * The number is asserted, not just used, because it is a CPU promise: the
     * verifier is the expensive part of a submission and this is the only thing
     * bounding how much of it one request can buy. 300 turns × ten actions a
     * turn — roughly three times the rate a real game sustains, and 6.7x below
     * the 20,000 it replaces.
     */
    expect(MAX_REPLAY_ACTIONS).toBe(3000);
    expect(MAX_REPLAY_ACTIONS).toBe(MAX_GAME_TURNS * 10);

    // Every fixture in this suite — including the long spectated ones — sits
    // comfortably inside it, which is what "cannot refuse an honest game" means.
    for (const game of [win, slowWin, loss, elimination]) {
      expect(game.replay.actions.length).toBeLessThan(MAX_REPLAY_ACTIONS / 2);
    }
  });

  it('refuses to spend CPU on an absurdly long replay', () => {
    const flood = {
      ...win.replay,
      actions: new Array(MAX_REPLAY_ACTIONS + 1).fill({ type: 'END_TURN' }),
    };
    const verdict = verifyDailyReplay(BOARD, flood);
    expect(verdict).toMatchObject({ ok: false, code: 'unverifiable' });
    expect(verdict.message).toMatch(/too long/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not a replay'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}],
    ['a replay with no actions', { version: 2, config: {} }],
    ['a replay with no config', { version: 2, actions: [] }],
    ['a replay whose actions are not a list', { version: 2, config: {}, actions: 'nope' }],
    ['a replay of nonsense actions', { version: 2, config: {}, actions: [{ type: 'MOON' }] }],
  ])('never throws on %s', (_label, garbage) => {
    const verdict = verifyDailyReplay(BOARD, garbage);
    expect(verdict.ok).toBe(false);
    expect(['wrong_board', 'unverifiable', 'not_finished']).toContain(verdict.code);
    expect(typeof verdict.message).toBe('string');
  });

  it('never throws on a replay whose actions are junk objects', () => {
    const junk = { ...win.replay, actions: [null, 5, { type: 'ATTACK', from: 'x' }] };
    expect(verifyDailyReplay(BOARD, junk).ok).toBe(false);
  });

  /**
   * The human's own actions are taken from the replay verbatim, so they are the
   * only place a malformed entry reaches the simulation as itself rather than
   * as a mismatch against a re-derived opponent move.
   */
  describe('malformed entries where a human action belongs', () => {
    /** Index of the first action the human takes, and the seat list it came from. */
    function firstHumanAction() {
      const seats = seatsPerAction(win.replay);
      const index = seats.indexOf(0);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    }

    it('does not mistake a null action for the end of the replay', () => {
      const index = firstHumanAction();
      const actions = win.replay.actions.map((action, i) => (i === index ? null : action));
      const verdict = verifyDailyReplay(BOARD, { ...win.replay, actions });
      // "Malformed", not "not_finished": a null in the list is a broken file,
      // not a game somebody walked away from.
      expect(verdict).toMatchObject({ ok: false, code: 'unverifiable' });
      expect(verdict.message).toMatch(/Malformed action/);
    });

    it('names an unknown action type', () => {
      const index = firstHumanAction();
      const actions = win.replay.actions.map((action, i) =>
        i === index ? { type: 'TELEPORT', from: 1, to: 2 } : action
      );
      const verdict = verifyDailyReplay(BOARD, { ...win.replay, actions });
      expect(verdict).toMatchObject({ ok: false, code: 'unverifiable' });
      expect(verdict.message).toMatch(/Unknown action type "TELEPORT"/);
    });
  });

  it('turns a hostile object that throws while being read into a rejection', () => {
    const booby = {
      version: 2,
      config: win.replay.config,
      get actions() {
        throw new Error('boom');
      },
    };
    const verdict = verifyDailyReplay(BOARD, booby);
    expect(verdict).toMatchObject({ ok: false, code: 'unverifiable' });
    expect(verdict.message).toMatch(/boom/);
  });
});
