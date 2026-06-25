/**
 * PPO self-play env core (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * Validates that `runSelfPlayEpisode` — which seats the learner as a synchronous
 * bot-fn shim and drives a full match through the engine's own `runMatch` — is
 * faithful to the engine:
 *
 *   - Integration oracle: a learner that reproduces a real bot's play (via the same
 *     index-decode the bridge uses) yields a final state byte-identical to a pure
 *     `runMatch` with that bot at the learner seat — move-for-move, RNG and all.
 *   - The STOP action ends the turn and the match still proceeds/terminates.
 *   - The episode is deterministic (same seed + same policy → same final state),
 *     i.e. the inversion threads RNG correctly (the [D-19] determinism anchor).
 *   - The terminal reward (won / placement) is coherent with the winner.
 *
 * Uses `ai_bc` as the reference policy: a deterministic, always-legal modern bot, so
 * the oracle has no RNG dependence and the learner-mimic can always find its index.
 */

import { runMatch } from '../../src/arena/matchRunner.js';
import { ai_bc } from '../../src/ai/ai_bc.js';
import { forward, argmax } from '../../src/ai/bcForward.js';
import { BC_POLICY } from '../../src/ai/bcPolicyWeights.js';

import {
  runSelfPlayEpisode,
  makeLearnerBot,
  LEARNER_NAME,
  scaledPlacement,
} from '../../scripts/lib/ppo-env.mjs';

const PLAYER_COUNT = 7;
const MAX_AREAS = BC_POLICY.config.maxAreas;
const MAX_TURNS = 500;

/*
 * These tests simulate full 7-FFA self-play matches (an ai_bc forward pass per decision) — pure
 * synchronous CPU. Under `--coverage` on a resource-capped CI runner each match is several seconds,
 * and a test body that runs two back-to-back blocks the worker's event loop long enough to starve
 * vitest's birpc heartbeat ("Timeout calling onTaskUpdate"), failing the run even though the tests
 * pass. Two mitigations: (1) `SHORT_TURNS` caps the matches whose assertion is turn-count-
 * independent (the lockstep/determinism/coherence checks all hold at any cap — they otherwise run
 * to the 500-turn stalemate cap); (2) `tick()` yields to the event loop between paired matches so
 * the heartbeat stays alive. The raised testTimeout is a backstop for a single match under load.
 */
vi.setConfig({ testTimeout: 30_000 });

/** Turn cap for tests whose property holds at any length — keeps each sync block short under coverage. */
const SHORT_TURNS = 60;

/** Yield to the event loop (a macrotask) so vitest's worker RPC can flush between heavy sync blocks. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** A learner that reproduces ai_bc: argmax over the same logits the BC bot uses. */
const mimicAiBc = encoded => argmax(forward(BC_POLICY, encoded).logits);

/** A learner that always ends its turn immediately (STOP slot is last). */
const alwaysStop = encoded => encoded.moves.length - 1;

/** Compare the salient, data-only parts of two final states. */
function projectState(s) {
  return {
    winner: s.winner,
    phase: s.phase,
    rngState: s.rngState,
    areas: s.areas.map(a => ({ id: a.id, owner: a.owner, dice: a.dice, size: a.size })),
    players: s.players.map(p => ({
      id: p.id,
      eliminated: p.eliminated,
      territoryCount: p.territoryCount,
      diceCount: p.diceCount,
    })),
  };
}

describe('runSelfPlayEpisode — integration oracle vs pure runMatch', () => {
  /*
   * A learner that reproduces ai_bc must yield the same game as ai_bc-at-that-seat. Byte-identical
   * lockstep holds at any length, so cap turns to keep each synchronous block short under coverage.
   */
  it.each([0, 3, 6])('learner mimicking ai_bc at seat %i matches runMatch', async seat => {
    const seed = 12345;

    const oracle = runMatch({
      bots: Array.from({ length: PLAYER_COUNT }, (_, i) => ({ name: `bc${i}`, fn: ai_bc })),
      seed,
      maxTurns: SHORT_TURNS,
      recordHistory: false,
    });

    await tick();

    const ep = runSelfPlayEpisode({
      seed,
      opponents: Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc })),
      learnerSeat: seat,
      maxAreas: MAX_AREAS,
      maxTurns: SHORT_TURNS,
      chooseAction: mimicAiBc,
    });

    expect(ep.turnCount).toBe(oracle.turnCount);
    expect(ep.winner).toBe(oracle.winner);
    expect(ep.placements).toEqual(oracle.placements);
    expect(projectState(ep.finalState)).toEqual(projectState(oracle.finalState));
  });
});

describe('runSelfPlayEpisode — STOP and reward semantics', () => {
  it('an always-STOP learner ends its turns and the match still terminates', () => {
    let decisions = 0;
    const ep = runSelfPlayEpisode({
      seed: 777,
      opponents: Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc })),
      learnerSeat: 2,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: encoded => {
        decisions++;
        return alwaysStop(encoded);
      },
    });

    expect(decisions).toBeGreaterThan(0); // the learner WAS asked to act
    // A passive seat surrounded by real bots gets conquered → someone wins, no stalemate.
    expect(ep.winner).not.toBeNull();
    expect(ep.winner).not.toBe(ep.learnerSeat);
    expect(ep.won).toBe(0);
    expect(ep.turnCount).toBeLessThan(MAX_TURNS);
  });

  it('reward fields are coherent with the winner', () => {
    // Coherence (won/winner/placement) holds regardless of length → cap to bound the sync block.
    const ep = runSelfPlayEpisode({
      seed: 4242,
      opponents: Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc })),
      learnerSeat: 1,
      maxAreas: MAX_AREAS,
      maxTurns: SHORT_TURNS,
      chooseAction: mimicAiBc,
    });

    expect(ep.won).toBe(ep.winner === ep.learnerSeat ? 1 : 0);
    expect(ep.placement).toBeGreaterThanOrEqual(0);
    expect(ep.placement).toBeLessThanOrEqual(1);
    expect(ep.placement).toBe(scaledPlacement(ep.placements, ep.learnerSeat, ep.playerCount));
    // Winner ⇒ best placement (1.0); a present seat is always ranked.
    if (ep.winner === ep.learnerSeat) expect(ep.placement).toBe(1);
    expect(ep.playerCount).toBe(PLAYER_COUNT);
  });
});

describe('runSelfPlayEpisode — determinism (RNG threaded correctly)', () => {
  it('same seed + same policy → identical final state and reward', async () => {
    // Determinism is length-independent → cap turns; yield between the two runs to free the worker.
    const cfg = {
      seed: 90210,
      opponents: Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc })),
      learnerSeat: 4,
      maxAreas: MAX_AREAS,
      maxTurns: SHORT_TURNS,
      chooseAction: mimicAiBc,
    };
    const a = runSelfPlayEpisode(cfg);
    await tick();
    const b = runSelfPlayEpisode(cfg);

    expect(b.turnCount).toBe(a.turnCount);
    expect(b.winner).toBe(a.winner);
    expect(b.won).toBe(a.won);
    expect(b.placement).toBe(a.placement);
    expect(projectState(b.finalState)).toEqual(projectState(a.finalState));
  });
});

describe('runSelfPlayEpisode — terminateOnElimination (PPO terminal)', () => {
  const sixAiBc = Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc }));

  it('ends the episode at the learner elimination, not at game-over', async () => {
    const cfg = {
      seed: 777,
      opponents: sixAiBc,
      learnerSeat: 2,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: alwaysStop,
    };
    const full = runSelfPlayEpisode(cfg); // plays the opponent-only tail out to game-over
    await tick();
    const early = runSelfPlayEpisode({ ...cfg, terminateOnElimination: true });

    // A passive seat among real bots is conquered; the early run stops strictly sooner.
    expect(early.eliminated).toBe(true);
    expect(early.won).toBe(0);
    expect(early.turnCount).toBeLessThan(full.turnCount);
    expect(early.finalState.players[2].eliminated).toBe(true);
    // The full game's tail is not simulated → the aborted match never built these.
    expect(early.placements).toBeNull();
    expect(early.botStats).toBeNull();
    expect(early.placement).toBeGreaterThanOrEqual(0);
    expect(early.placement).toBeLessThanOrEqual(1);
  });

  it('stops on the exact turn of elimination, with the engine-equivalent placement', async () => {
    let firstElimTurn = -1;
    const cfg = {
      seed: 777,
      opponents: sixAiBc,
      learnerSeat: 2,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: alwaysStop,
    };
    const full = runSelfPlayEpisode({
      ...cfg,
      onTurn: (t, state) => {
        if (firstElimTurn === -1 && state.players[2].eliminated) firstElimTurn = t;
      },
    });
    await tick();
    const early = runSelfPlayEpisode({ ...cfg, terminateOnElimination: true });

    expect(firstElimTurn).toBeGreaterThan(0);
    expect(early.turnCount).toBe(firstElimTurn);
    // Placement synthesized at death (rank = #alive) equals calculatePlacements at game-over.
    expect(early.placement).toBe(scaledPlacement(full.placements, 2, PLAYER_COUNT));
  });

  /*
   * Same-turn co-elimination: the opponent turn that kills the learner ALSO kills another player.
   * `aliveCount` alone misses a co-eliminee with a HIGHER seat id than the learner (it finishes
   * above the learner via runMatch's ascending-id tie-break), so eliminationOutcome adds it back.
   * These fixtures were found empirically; the deathElims>1 precondition fails LOUD (not silently
   * passes) if engine RNG ever shifts a seed off its co-elimination. Opponents are ai_bc on purpose:
   * the early-vs-full placement oracle only holds for DETERMINISTIC opponents (ai_default/example/
   * adaptive use global Math.random and would desync the two runs). Cases span seat 0 (every
   * co-eliminee is higher-id) and non-zero seats (which also exercise the EXCLUDE-lower-id branch).
   */
  it.each([
    [0, 23], // seat 0 — co-eliminee higher-id, game still undecided
    [3, 37], // seat 3 — non-zero seat, mixed-id co-elimination
    [1, 20], // seat 1 — non-zero seat, eliminating turn also ends the game
  ])('co-elimination placement matches calculatePlacements (seat %i, seed %i)', async (seat, seed) => {
    const opponents = Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc }));
    let deathElims = 0;
    let prevElim = 0;
    let sawDeath = false;
    const full = runSelfPlayEpisode({
      seed,
      opponents,
      learnerSeat: seat,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: alwaysStop,
      onTurn: (_t, s) => {
        const e = s.players.filter(p => p.eliminated).length;
        if (!sawDeath && s.players[seat].eliminated) {
          deathElims = e - prevElim;
          sawDeath = true;
        }
        prevElim = e;
      },
    });
    await tick();
    const early = runSelfPlayEpisode({
      seed,
      opponents,
      learnerSeat: seat,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: alwaysStop,
      terminateOnElimination: true,
    });

    expect(deathElims).toBeGreaterThan(1); // precondition: this seed really IS a co-elimination turn
    expect(early.eliminated).toBe(true);
    expect(early.placement).toBe(scaledPlacement(full.placements, seat, PLAYER_COUNT));
  });

  it('an elimination that also ends the game reports the engine winner with won=0 (runner-up)', async () => {
    /*
     * seed 60 / seat 0: the opponent turn that eliminates the learner also wins the game — the
     * terminal carries a NON-null winner together with eliminated=true and won=0 (the learner is
     * the runner-up). This is the wire combo the env-server forwards as `winner != -1, won = 0`.
     */
    const seat = 0;
    const opponents = Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc }));
    const full = runSelfPlayEpisode({
      seed: 60,
      opponents,
      learnerSeat: seat,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: alwaysStop,
    });
    await tick();
    const early = runSelfPlayEpisode({
      seed: 60,
      opponents,
      learnerSeat: seat,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: alwaysStop,
      terminateOnElimination: true,
    });

    expect(early.eliminated).toBe(true);
    expect(early.winner).not.toBeNull();
    expect(early.winner).not.toBe(seat); // the learner cannot be its own eliminator's winner
    expect(early.won).toBe(0);
    // Exact parity with the engine's game-over placement, not just a [0,1] bounds check.
    expect(early.placement).toBe(scaledPlacement(full.placements, seat, PLAYER_COUNT));
  });

  it('is a no-op when the learner wins — identical to the full game', async () => {
    /*
     * A learner that survives to game-over never trips the early-termination guard, so the path
     * falls through to the same completed-match result, byte for byte. seed 11 is a learner win.
     */
    const cfg = {
      seed: 11,
      opponents: sixAiBc,
      learnerSeat: 0,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: mimicAiBc,
    };
    const full = runSelfPlayEpisode(cfg);
    await tick();
    const early = runSelfPlayEpisode({ ...cfg, terminateOnElimination: true });

    expect(early.won).toBe(1); // learner conquers the board — a genuine game-over win
    expect(early.winner).toBe(0);
    expect(early.eliminated).toBe(false);
    expect(early.turnCount).toBe(full.turnCount);
    expect(early.winner).toBe(full.winner);
    expect(early.placement).toBe(full.placement);
    expect(early.placements).toEqual(full.placements);
    expect(projectState(early.finalState)).toEqual(projectState(full.finalState));
  });
});

describe('runSelfPlayEpisode — onTurn is the abort seam (env-server disconnect contract)', () => {
  const sixAiBc = Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc }));

  it('a throw from onTurn unwinds the episode and is not mistaken for the elimination sentinel', () => {
    /*
     * The env-server cannot signal a mid-episode disconnect by throwing from chooseAction (see the
     * next test) — it throws from onTurn instead. This pins that an onTurn throw propagates OUT of
     * runSelfPlayEpisode even in terminateOnElimination mode (the internal LEARNER_ELIMINATED catch
     * must re-raise any other error), which is exactly what makes the disconnect break reachable.
     */
    expect(() =>
      runSelfPlayEpisode({
        seed: 777,
        opponents: sixAiBc,
        learnerSeat: 2,
        maxAreas: MAX_AREAS,
        maxTurns: MAX_TURNS,
        chooseAction: alwaysStop,
        terminateOnElimination: true,
        onTurn: t => {
          if (t === 3) throw new Error('onTurn abort signal');
        },
      })
    ).toThrow('onTurn abort signal');
  });

  it('a throw from chooseAction is swallowed by the engine (forfeit), not propagated', () => {
    /*
     * The learner runs as an ordinary bot fn, and runBotDirect catches every bot-fn throw and just
     * forfeits the turn. So a chooseAction that always throws does NOT surface as an episode error —
     * the learner simply never moves and is conquered. This is the reason the disconnect signal must
     * travel via onTurn, and it is the bug the env-server's old `if (err instanceof EnvClosed) break`
     * silently relied on (the break was dead code).
     */
    let calls = 0;
    const ep = runSelfPlayEpisode({
      seed: 777,
      opponents: sixAiBc,
      learnerSeat: 2,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      chooseAction: () => {
        calls++;
        throw new Error('learner blew up');
      },
      terminateOnElimination: true,
    });
    expect(calls).toBeGreaterThan(0); // the learner WAS asked to act
    expect(ep.eliminated).toBe(true); // a forfeiting seat among real bots is conquered
    expect(ep.won).toBe(0);
  });
});

describe('makeLearnerBot — input validation', () => {
  it('rejects a non-positive-integer maxAreas', () => {
    expect(() => makeLearnerBot({ maxAreas: 0, chooseAction: () => 0 })).toThrow(
      /maxAreas must be a positive integer/
    );
    expect(() => makeLearnerBot({ maxAreas: 2.5, chooseAction: () => 0 })).toThrow(
      /maxAreas must be a positive integer/
    );
  });

  it('rejects a non-function chooseAction', () => {
    expect(() => makeLearnerBot({ maxAreas: 8, chooseAction: 'nope' })).toThrow(
      /chooseAction must be a function/
    );
  });
});

describe('runSelfPlayEpisode — input validation', () => {
  const baseOpponents = [{ name: 'bc', fn: ai_bc }, { name: 'bc2', fn: ai_bc }];

  it('uniquifies duplicate opponent names so runMatch does not reject the roster', () => {
    /*
     * A self-play league routinely seats the same bot at several seats → identical names. runMatch
     * requires unique names ("Bot names must be unique"); runSelfPlayEpisode must suffix the dupes.
     * If uniquifyNames regressed, this would throw rather than complete.
     */
    const dupes = Array.from({ length: PLAYER_COUNT - 1 }, () => ({ name: 'bc', fn: ai_bc }));
    const ep = runSelfPlayEpisode({
      seed: 5,
      opponents: dupes,
      learnerSeat: 0,
      maxAreas: MAX_AREAS,
      maxTurns: SHORT_TURNS, // only asserts playerCount → length-independent, cap it
      chooseAction: mimicAiBc,
    });
    expect(ep.playerCount).toBe(PLAYER_COUNT);
  });

  it('rejects a non-finite seed (training mode needs a numeric seed)', () => {
    expect(() =>
      runSelfPlayEpisode({
        seed: undefined,
        opponents: baseOpponents,
        learnerSeat: 0,
        maxAreas: MAX_AREAS,
        chooseAction: mimicAiBc,
      })
    ).toThrow(/seed must be a finite number/);
  });

  it('rejects a learnerSeat outside [0, playerCount)', () => {
    expect(() =>
      runSelfPlayEpisode({
        seed: 1,
        opponents: baseOpponents,
        learnerSeat: 3, // playerCount = 3 → valid seats 0..2
        maxAreas: MAX_AREAS,
        chooseAction: mimicAiBc,
      })
    ).toThrow(/learnerSeat 3 out of range/);
  });

  it('uses LEARNER_NAME for the learner seat in the roster', () => {
    // Smoke: a 3-seat episode runs end-to-end and the learner name constant is stable.
    expect(LEARNER_NAME).toBe('ppo-learner');
    const ep = runSelfPlayEpisode({
      seed: 5,
      opponents: baseOpponents,
      learnerSeat: 0,
      maxAreas: MAX_AREAS,
      maxTurns: SHORT_TURNS, // smoke only asserts playerCount → length-independent, cap it
      chooseAction: mimicAiBc,
    });
    expect(ep.playerCount).toBe(3);
  });
});
