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

import { runSelfPlayEpisode, LEARNER_NAME, scaledPlacement } from '../../scripts/lib/ppo-env.mjs';

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

describe('runSelfPlayEpisode — input validation', () => {
  const baseOpponents = [{ name: 'bc', fn: ai_bc }, { name: 'bc2', fn: ai_bc }];
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
