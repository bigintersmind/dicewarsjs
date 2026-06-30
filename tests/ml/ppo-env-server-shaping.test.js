/**
 * PPO env-server dense-reward EMISSION seam (ml-bot "bite G" / [D-28]) — issue #84.
 *
 * The bite-G wire was tested on both ends in isolation — the binary codec (`obs-frame.test.js`),
 * the measurement tracker (`ppo-reward-shaping.test.js`), and the Python `step()` reward math
 * (`ml/tests/test_reward_modes.py`) — but the Node env-server GLUE that wires them ran only on a
 * live shodan spawn. This suite closes that gap by exercising the REAL glue, now extracted from
 * `main()` into the exported `makeShapedEmission` factory (the exact functions `ppo-env-server.mjs`
 * wires into its episode loop), so a regression fails in CI instead of silently training the wrong
 * objective on a multi-day GPU run.
 *
 * It pins, against the real `makeShapedEmission` (not a re-implementation):
 *   - the per-decision `.territories` read at the acting seat (`botState.myPlayer`),
 *   - the terminal `.territories` read at the learner seat,
 *   - the `recordTurn`-before-`failIfLost` `onTurn` ORDERING (a game-ending kill on the learner's
 *     final turn is still credited for the terminal frame),
 *   - the per-episode `reset()` (no territory-baseline / kill-count leak across episodes),
 *   - the `...shapingFields` threading onto BOTH the obs and terminal frames (`shaped` flag + the
 *     `deltaTerritory`/`elimsByLearner` tail on the wire), and
 *   - the OFF path staying byte-identical (no tail, `wrapOnTurn` returns the bare guard).
 *
 * The unit tests drive the glue with stub frames (instant, pinpointing each regression); the final
 * test drives it through a REAL `runSelfPlayEpisode` + the real frame codec round-trip, so a rename
 * of `botState.territories` in `src/arena/botState.js` (the issue's concrete failure #1) surfaces as
 * a NaN delta end-to-end. Per the issue, this is the CI-gating check: the JS `tests/ml/*` suite runs
 * in CI (`ci.yml` → `npm run test:coverage`), whereas the live Python e2e (`ml/tests/test_ppo_env.py`)
 * skips there because the ML CI job installs no `node`.
 */

import {
  NODE_FEATURES,
  PLAYER_FEATURES,
  BOARD_FEATURES,
  EDGE_FEATURES,
  encodeObservationForInference,
} from '../../src/arena/encodeObservation.js';
import { createBotState } from '../../src/arena/botState.js';
import { ai_bc } from '../../src/ai/ai_bc.js';
import { forward, argmax } from '../../src/ai/bcForward.js';
import { BC_POLICY } from '../../src/ai/bcPolicyWeights.js';

import { makeShapedEmission } from '../../scripts/ppo-env-server.mjs';
import { createRewardShapingTracker } from '../../scripts/lib/ppo-reward-shaping.mjs';
import { serializeObsFrame, parseObsFrame } from '../../scripts/lib/obs-frame.mjs';
import { runSelfPlayEpisode } from '../../scripts/lib/ppo-env.mjs';

/*
 * The end-to-end test runs a full 7-FFA self-play match (an ai_bc forward pass per decision) — the
 * same sync-CPU cost the sibling ppo-env suite raises its timeout for. The unit tests are instant.
 */
vi.setConfig({ testTimeout: 30_000 });

const NODE_W = NODE_FEATURES.length;
const PLAYER_W = PLAYER_FEATURES.length;
const BOARD_W = BOARD_FEATURES.length;
const EDGE_W = EDGE_FEATURES.length;

const MAX_AREAS = BC_POLICY.config.maxAreas;
const MAX_TURNS = 500;
const PLAYER_COUNT = 7;

const zeros = (h, w) => Array.from({ length: h }, () => new Array(w).fill(0));

/** A structurally-valid stub `encoded` (real tensor dims) so the built frame actually serializes. */
function stubEncoded({ maxAreas, playerCount, numEdges = 2 }) {
  return {
    nodes: zeros(maxAreas, NODE_W),
    players: zeros(playerCount, PLAYER_W),
    board: new Array(BOARD_W).fill(0),
    edges: zeros(numEdges, EDGE_W),
    edgeIndex: zeros(numEdges, 2),
    moves: new Array(numEdges).fill(null), // length drives the header's numEdges (content unused here)
  };
}

/** A stub `botState`: only the fields `buildObsFrame` + the shaping `.territories` read touch. */
function stubBotState({ myPlayer, turnNumber = 5, territoriesBySeat }) {
  return {
    myPlayer,
    turnNumber,
    players: territoriesBySeat.map((t, id) => ({ id, territories: t })),
  };
}

/** A minimal engine-state stub for `recordTurn` (reads only `players[].{id,eliminated}`). */
function stateWith(eliminatedIds, n = 4) {
  return {
    players: Array.from({ length: n }, (_, id) => ({ id, eliminated: eliminatedIds.includes(id) })),
  };
}

/** Serialize then parse-with-tail — asserts on the actual WIRE values, not just the frame object. */
const roundTripShaped = frame => parseObsFrame(serializeObsFrame(frame), { shaped: true });

describe('makeShapedEmission — OFF (no tracker ⇒ byte-identical wire)', () => {
  const maxAreas = 4;
  const playerCount = 3;
  const emission = makeShapedEmission({ shapingTracker: null, maxAreas, learnerSeat: 0 });

  it('decisionFrame omits the shaped tail (base wire, no dense fields)', () => {
    const enc = stubEncoded({ maxAreas, playerCount });
    const frame = emission.decisionFrame(enc, stubBotState({ myPlayer: 0, territoriesBySeat: [5, 4, 3] }));
    expect(frame.shaped).toBe(false);
    const buf = serializeObsFrame(frame);
    // A base parse succeeds; a shaped parse hits the length guard ⇒ there is genuinely no tail.
    expect(parseObsFrame(buf).shaped).toBe(false);
    expect(() => parseObsFrame(buf, { shaped: true })).toThrow(/bytes ≠ expected/);
  });

  it('terminalFrame omits the tail but still carries the terminal meta', () => {
    const enc = stubEncoded({ maxAreas, playerCount });
    const frame = emission.terminalFrame(enc, stubBotState({ myPlayer: 0, territoriesBySeat: [5, 4, 3] }), {
      terminal: 1,
      winner: 1,
      won: 0,
      truncated: 0,
      placement: 0.5,
    });
    expect(frame.shaped).toBe(false);
    expect(frame.terminal).toBe(1);
    expect(frame.winner).toBe(1);
    expect(() => parseObsFrame(serializeObsFrame(frame), { shaped: true })).toThrow(/bytes ≠ expected/);
  });

  it('wrapOnTurn returns the failIfLost guard UNCHANGED (same reference)', () => {
    const failIfLost = () => {};
    expect(emission.wrapOnTurn(failIfLost)).toBe(failIfLost);
  });

  it('reset() is a no-op and does not throw', () => {
    expect(() => emission.reset()).not.toThrow();
  });
});

describe('makeShapedEmission — per-decision shaped emission', () => {
  const maxAreas = 4;
  const playerCount = 3;

  it('threads the dense tail and reads .territories at the acting seat (myPlayer, not learnerSeat)', () => {
    // The factory's learnerSeat (0) deliberately differs from the acting seat (myPlayer 2), each
    // carrying a DIFFERENT territory count, so the read site is unambiguous: a decision frame must
    // index botState.myPlayer (the acting learner's own seat) — reading learnerSeat would yield a
    // different delta. (In production myPlayer === learnerSeat on every decision frame, so the two
    // are equivalent there; this pins which one the code actually reads.)
    const tracker = createRewardShapingTracker(0);
    const emission = makeShapedEmission({ shapingTracker: tracker, maxAreas, learnerSeat: 0 });
    const enc = stubEncoded({ maxAreas, playerCount });
    emission.reset();

    // Frame 1 (episode baseline): acting seat 2 owns 8 (decoy seat 0 owns 1) → delta 0.
    const f1 = roundTripShaped(emission.decisionFrame(enc, stubBotState({ myPlayer: 2, territoriesBySeat: [1, 1, 8] })));
    expect(f1.shaped).toBe(true);
    expect(f1.activePlayerId).toBe(2);
    expect(f1.deltaTerritory).toBe(0);
    expect(f1.elimsByLearner).toBe(0);

    // Frame 2: acting seat 2 now owns 11 → +3 (NOT the decoy seat 0 = 99). A `.territories` rename
    // would read undefined ⇒ NaN; a learnerSeat/myPlayer swap would read 99 → a different delta.
    const f2 = roundTripShaped(emission.decisionFrame(enc, stubBotState({ myPlayer: 2, territoriesBySeat: [99, 1, 11] })));
    expect(f2.deltaTerritory).toBe(3);

    // Frame 3: a net LOSS is honest (not floored): seat 2 11 → 6 = -5.
    const f3 = roundTripShaped(emission.decisionFrame(enc, stubBotState({ myPlayer: 2, territoriesBySeat: [50, 1, 6] })));
    expect(f3.deltaTerritory).toBe(-5);
  });
});

describe('makeShapedEmission — terminal shaped emission', () => {
  const maxAreas = 4;
  const playerCount = 3;

  it('reads .territories at learnerSeat (not myPlayer) and threads the terminal meta + tail', () => {
    const tracker = createRewardShapingTracker(1); // learner seat 1
    const emission = makeShapedEmission({ shapingTracker: tracker, maxAreas, learnerSeat: 1 });
    const enc = stubEncoded({ maxAreas, playerCount });
    emission.reset();

    // Baseline decision: the learner (seat 1) owns 6.
    emission.decisionFrame(enc, stubBotState({ myPlayer: 1, territoriesBySeat: [2, 6, 2] }));

    // Terminal: the learner is eliminated ⇒ 0 territories at seat 1. `myPlayer` is deliberately set
    // to 0 (carrying a decoy 99) to PROVE the read indexes learnerSeat, not myPlayer.
    const term = roundTripShaped(
      emission.terminalFrame(enc, stubBotState({ myPlayer: 0, territoriesBySeat: [99, 0, 2] }), {
        terminal: 1,
        winner: 2,
        won: 0,
        truncated: 0,
        placement: 0.25,
      })
    );
    expect(term.shaped).toBe(true);
    expect(term.terminal).toBe(1);
    expect(term.winner).toBe(2);
    expect(term.placement).toBeCloseTo(0.25);
    expect(term.deltaTerritory).toBe(-6); // 0 (seat 1) − 6, NOT 99 (myPlayer) − 6
  });
});

describe('makeShapedEmission — onTurn ordering (recordTurn BEFORE failIfLost)', () => {
  it('folds the game-ending kill before failIfLost throws, so it still credits the terminal', () => {
    const tracker = createRewardShapingTracker(0); // learner seat 0
    const emission = makeShapedEmission({ shapingTracker: tracker, maxAreas: 4, learnerSeat: 0 });
    emission.reset();
    tracker.frameSignals(5); // the learner's final decision frame (baseline for the next interval)

    // The learner's game-ending turn (currentPlayerId 0) eliminates seat 1 AND the learner is lost.
    const onTurn = emission.wrapOnTurn(() => {
      throw new Error('learner lost'); // the failIfLost re-raise on the death turn
    });
    expect(() => onTurn(42, stateWith([1]), 0)).toThrow('learner lost');

    // recordTurn ran FIRST → the kill is folded and surfaces on the terminal frame. If the order
    // were inverted (failIfLost first), the throw would skip recordTurn ⇒ this would be 0.
    expect(tracker.frameSignals(0).elimsByLearner).toBe(1);
  });

  it('does NOT credit an opponent kill on a non-learner turn (attribution by acting seat)', () => {
    const tracker = createRewardShapingTracker(0);
    const emission = makeShapedEmission({ shapingTracker: tracker, maxAreas: 4, learnerSeat: 0 });
    emission.reset();
    tracker.frameSignals(5);
    // Seat 2 eliminates seat 1 on ITS own turn → not the learner's kill.
    emission.wrapOnTurn(() => {})(7, stateWith([1]), 2);
    expect(tracker.frameSignals(0).elimsByLearner).toBe(0);
  });
});

describe('makeShapedEmission — per-episode reset (no cross-episode leak)', () => {
  it('reset() clears the territory baseline AND the kill count between episodes', () => {
    const tracker = createRewardShapingTracker(0);
    const emission = makeShapedEmission({ shapingTracker: tracker, maxAreas: 4, learnerSeat: 0 });
    const enc = stubEncoded({ maxAreas: 4, playerCount: 3 });

    // Episode 1: baseline 5, then 9 (+4); plus a learner kill of seat 1.
    emission.reset();
    emission.decisionFrame(enc, stubBotState({ myPlayer: 0, territoriesBySeat: [5, 1, 1] }));
    const e1f2 = roundTripShaped(emission.decisionFrame(enc, stubBotState({ myPlayer: 0, territoriesBySeat: [9, 1, 1] })));
    expect(e1f2.deltaTerritory).toBe(4);
    emission.wrapOnTurn(() => {})(3, stateWith([1]), 0); // a kill banked in episode 1

    // Episode 2: reset ⇒ the FIRST frame is a fresh baseline. Dropping reset() would leak the
    // territory cursor (9 → 2 = -7) and the banked kill (elims 1) into the new episode.
    emission.reset();
    const e2f1 = roundTripShaped(emission.decisionFrame(enc, stubBotState({ myPlayer: 0, territoriesBySeat: [2, 1, 1] })));
    expect(e2f1.deltaTerritory).toBe(0);
    expect(e2f1.elimsByLearner).toBe(0);
  });
});

describe('makeShapedEmission — end-to-end through runSelfPlayEpisode (real engine + codec)', () => {
  const mimicAiBc = encoded => argmax(forward(BC_POLICY, encoded).logits);
  const sixAiBc = Array.from({ length: PLAYER_COUNT - 1 }, (_, i) => ({ name: `bc${i}`, fn: ai_bc }));

  it('emits shaped frames over a real winning episode and credits the game-ending kill', () => {
    const learnerSeat = 0;
    const tracker = createRewardShapingTracker(learnerSeat);
    const emission = makeShapedEmission({ shapingTracker: tracker, maxAreas: MAX_AREAS, learnerSeat });

    const decisionFrames = [];
    emission.reset(); // main resets at the episode boundary
    const result = runSelfPlayEpisode({
      seed: 11, // a learner win by board conquest (the anchor seed in ppo-env.test.js)
      opponents: sixAiBc,
      learnerSeat,
      maxAreas: MAX_AREAS,
      maxTurns: MAX_TURNS,
      // chooseAction mirrors main(): build + serialize the shaped decision frame, then pick the move.
      chooseAction: (encoded, botState) => {
        const buf = serializeObsFrame(emission.decisionFrame(encoded, botState));
        decisionFrames.push(parseObsFrame(buf, { shaped: true }));
        return mimicAiBc(encoded);
      },
      // onTurn is the wrapped guard; failIfLost is a no-op here (no socket to lose).
      onTurn: emission.wrapOnTurn(() => {}),
      terminateOnElimination: true,
    });

    expect(result.won).toBe(1); // sanity: seed 11 is still a learner win (fails loud if RNG shifts)

    // Terminal frame, built exactly as main() does — createBotState at the learner seat.
    const termState = createBotState(result.finalState, learnerSeat);
    const termEnc = encodeObservationForInference(termState, { maxAreas: MAX_AREAS });
    const termBuf = serializeObsFrame(
      emission.terminalFrame(termEnc, termState, {
        terminal: 1,
        winner: result.winner ?? -1,
        won: result.won,
        truncated: result.truncated ? 1 : 0,
        placement: result.placement,
      })
    );
    // The dense tail is genuinely on the wire: a base parse hits the length guard.
    expect(() => parseObsFrame(termBuf)).toThrow(/bytes ≠ expected/);
    const term = parseObsFrame(termBuf, { shaped: true });

    expect(decisionFrames.length).toBeGreaterThan(0);
    for (const f of decisionFrames) {
      expect(f.shaped).toBe(true);
      // A renamed/restructured botState.territories would read undefined ⇒ NaN (issue failure #1).
      expect(Number.isFinite(f.deltaTerritory)).toBe(true);
      expect(f.elimsByLearner).toBeGreaterThanOrEqual(0);
    }
    expect(term.terminal).toBe(1);
    expect(Number.isFinite(term.deltaTerritory)).toBe(true);

    // The learner conquered the board → its territory genuinely changed (not an all-zero stream) ...
    const allDeltas = [...decisionFrames.map(f => f.deltaTerritory), term.deltaTerritory];
    expect(allDeltas.some(d => d !== 0)).toBe(true);
    // ... and made at least the final elimination. elimsByLearner telescopes across frames, so the
    // SUM over decisions + terminal equals the learner's total attributed kills (≥ 1 for a board win).
    const totalKills =
      decisionFrames.reduce((s, f) => s + f.elimsByLearner, 0) + term.elimsByLearner;
    expect(totalKills).toBeGreaterThanOrEqual(1);
  });
});
