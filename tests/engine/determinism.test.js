/**
 * Determinism & training-mode harness tests.
 *
 * Phase 1 / PR 1 of the ML self-play harness (docs/ml-bot/PLAN.md, tasks 1–2):
 * the self-play loop is only useful if a seed reproduces a game exactly and the
 * training-mode `recordHistory:false` flag changes *nothing* about play — it only
 * suppresses the side log. These tests pin both invariants.
 *
 * Node env (default — no jsdom): the engine and arena runners have no DOM deps.
 * Determinism is asserted with **seed-pure bots only** (Strategist, Lookahead,
 * Expectimax, Defensive). The other three built-ins (Default, Example, Adaptive)
 * call `Math.random` and are intentionally excluded — they are non-reproducible.
 */

import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { ACTION_TYPES, GAME_PHASES } from '../../src/engine/constants.js';
import { runMatch } from '../../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { createReplayFromState, replayToState } from '../../src/arena/replayFormat.js';

/** The four built-in bots that never call Math.random — safe for determinism. */
const SEED_PURE_IDS = ['ai_strategist', 'ai_lookahead', 'ai_expectimax', 'ai_defensive'];

const seedPureBots = () =>
  SEED_PURE_IDS.map(id => {
    const bot = BUILT_IN_BOTS.find(b => b.id === id);
    if (!bot) throw new Error(`Test setup error: built-in bot "${id}" not found`);
    return { name: bot.name, fn: bot.fn };
  });

/**
 * A compact, comparable fingerprint of a finished game. rngState is the sharpest
 * single signal — any divergence in RNG threading flips it — and the per-area
 * owner/dice/size catches board-level drift.
 */
function digestMatch(result) {
  return {
    winner: result.winner,
    turnCount: result.turnCount,
    placements: result.placements,
    rngState: result.finalState.rngState,
    board: result.finalState.areas.map(a => ({ owner: a.owner, dice: a.dice, size: a.size })),
  };
}

/**
 * Drive a game to completion with a fully deterministic, engine-only policy:
 * always take the first legal attack (bounded per turn), else END_TURN. No bots,
 * no Math.random — used to exercise the raw engine + replay path.
 */
function runEngineGame(config, { maxTurns = 120, maxAttacksPerTurn = 25 } = {}) {
  let state = createGame(config);
  let turns = 0;
  while (state.phase !== GAME_PHASES.GAME_OVER && turns < maxTurns) {
    for (let a = 0; a < maxAttacksPerTurn; a++) {
      if (state.phase === GAME_PHASES.GAME_OVER) break;
      const moves = getValidMoves(state);
      if (moves.length === 0) break;
      state = applyAction(state, {
        type: ACTION_TYPES.ATTACK,
        from: moves[0].from,
        to: moves[0].to,
      });
    }
    if (state.phase === GAME_PHASES.GAME_OVER) break;
    state = applyAction(state, { type: ACTION_TYPES.END_TURN });
    turns++;
  }
  return state;
}

describe('engine determinism — same seed → identical game', () => {
  const seeds = [42, 1337, 2026];

  it.each(seeds)('seed-pure bot field reproduces exactly (seed %i)', seed => {
    const a = runMatch({ bots: seedPureBots(), seed, maxTurns: 200 });
    const b = runMatch({ bots: seedPureBots(), seed, maxTurns: 200 });
    expect(digestMatch(b)).toEqual(digestMatch(a));
  });

  it.each(seeds)('raw engine driver reproduces exactly (seed %i)', seed => {
    const a = runEngineGame({ seed });
    const b = runEngineGame({ seed });
    expect(b.rngState).toBe(a.rngState);
    expect(b.winner).toBe(a.winner);
    expect(b.areas.map(x => [x.owner, x.dice, x.size])).toEqual(
      a.areas.map(x => [x.owner, x.dice, x.size])
    );
  });

  it('different seeds produce different games (seeding is actually wired up)', () => {
    /*
     * Guards the inverse failure mode: if the seed were silently ignored, every
     * same-seed comparison above would still pass trivially. This pins that the
     * seed actually threads into match construction.
     */
    const a = digestMatch(runMatch({ bots: seedPureBots(), seed: 42, maxTurns: 200 }));
    const b = digestMatch(runMatch({ bots: seedPureBots(), seed: 1337, maxTurns: 200 }));
    expect(b).not.toEqual(a);
  });
});

describe('training-mode recordHistory flag', () => {
  it('records history by default', () => {
    const r = runMatch({ bots: seedPureBots(), seed: 42, maxTurns: 200 });
    expect(r.finalState.history.length).toBeGreaterThan(0);
  });

  it('recordHistory:false yields an empty history but identical play', () => {
    const withHist = runMatch({ bots: seedPureBots(), seed: 42, maxTurns: 200 });
    const noHist = runMatch({
      bots: seedPureBots(),
      seed: 42,
      maxTurns: 200,
      recordHistory: false,
    });

    expect(noHist.finalState.history).toHaveLength(0);
    // The flag governs only the side log — the game itself is byte-identical.
    expect(digestMatch(noHist)).toEqual(digestMatch(withHist));
  });

  it('keeps state.history empty across every applyAction at the engine level', () => {
    const final = runEngineGame({ seed: 7, recordHistory: false });
    expect(final.history).toHaveLength(0);
    expect(final.config.recordHistory).toBe(false);
  });
});

describe('createGame — training-mode explicit-seed gate', () => {
  it('throws when recordHistory:false and no seed is given', () => {
    expect(() => createGame({ recordHistory: false })).toThrow(/explicit.*seed/i);
  });

  it('throws when recordHistory:false and seed is null or NaN (not just undefined)', () => {
    /*
     * The gate must match the `?? ` fallback's nullish notion (+ reject NaN), or a
     * null/NaN seed would silently fall back to a random seed in training mode.
     */
    expect(() => createGame({ recordHistory: false, seed: null })).toThrow(/seed/i);
    expect(() => createGame({ recordHistory: false, seed: NaN })).toThrow(/seed/i);
  });

  it('allows recordHistory:false with an explicit seed', () => {
    const state = createGame({ recordHistory: false, seed: 1 });
    expect(state.config.recordHistory).toBe(false);
    expect(state.history).toEqual([]);
  });

  it('production default keeps the random-seed fallback (no throw, history on)', () => {
    const state = createGame({}); // no seed, recordHistory defaults on
    expect(typeof state.config.seed).toBe('number');
    expect(state.config.recordHistory).toBe(true);
  });
});

describe('replay round-trip persists dicePerArea', () => {
  it('reconstructs an identical final state at non-default dice', () => {
    const dicePerArea = 5; // non-default (DEFAULT_DICE_PER_AREA === 3)
    const seed = 99;

    const final = runEngineGame({ seed, dicePerArea });
    expect(final.history.length).toBeGreaterThan(0); // default recordHistory → log exists

    const replay = createReplayFromState(final, { bots: [], winner: final.winner });
    // The fix: dicePerArea is carried in the replay config so the map regenerates identically.
    expect(replay.config.dicePerArea).toBe(dicePerArea);

    const reconstructed = replayToState(replay, replay.actions.length);
    expect(reconstructed.rngState).toBe(final.rngState);
    for (let i = 1; i < final.areas.length; i++) {
      expect(reconstructed.areas[i].owner).toBe(final.areas[i].owner);
      expect(reconstructed.areas[i].dice).toBe(final.areas[i].dice);
    }
  });

  it('without dicePerArea the round-trip diverges (pins the consequence of the fix)', () => {
    const dicePerArea = 5;
    const seed = 99;
    const final = runEngineGame({ seed, dicePerArea });
    const replay = createReplayFromState(final, { bots: [], winner: final.winner });

    /*
     * Simulate the pre-fix replay: strip dicePerArea so reconstruction falls back
     * to the default (3). The map regenerates with different dice AND a shifted RNG
     * state, so the recorded dice-5 actions no longer reproduce the game — it either
     * throws mid-replay (an action hits a now-wrongly-owned territory) or lands on a
     * different final state. Either way it must NOT cleanly reproduce.
     */
    const stripped = { ...replay, config: { ...replay.config } };
    delete stripped.config.dicePerArea;

    let diverged = false;
    try {
      const reconstructed = replayToState(stripped, replay.actions.length);
      diverged = reconstructed.rngState !== final.rngState;
    } catch {
      diverged = true;
    }
    expect(diverged).toBe(true);
  });
});
