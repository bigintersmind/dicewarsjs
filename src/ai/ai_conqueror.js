/**
 * Conqueror — the balanced, win-maximizing persona (the player-facing flagship).
 *
 * One of the three shipped self-play "personas" (`docs/ml-bot/PERSONAS.md`). Conqueror
 * is the all-around bot: it plays for the win over a long horizon. Since 2026-07-05 its
 * weights are the **encoding-v3 net** (`ppo-v3-scratch`, [D-31]) — a 20M from-scratch
 * PPO run whose observation adds owner identity, income economics, turn order, and the
 * game clock. It passed every pre-registered [D-31] §4 bar: beat the v2 scratch control
 * head-to-head (the encoding A/B, +6.1 pp), beat Survivor (+5.5 pp — previously the
 * strongest net), and holds +33.9 pp over `ai_lookahead` — making it the strongest net
 * the game ships. (Conqueror previously aliased the v2 `ppo-long` weights; the hidden
 * dev-harness `PPO` bot still ships those, unchanged, as the fixed `ppo:gate` baseline.)
 *
 * Runs as just another modern bot — `(BotState) => { from, to } | null` — over the
 * shared EdgePolicyNet + synchronous pure-JS forward pass (`bcForward.js`) and the v3
 * observation encoder. `makeBC`'s encoder-version guard validates the weights at import
 * time. The exported symbol in `conquerorPolicyWeights.js` is named `BC_POLICY` (same
 * exporter for every net); we alias it to `CONQUEROR_POLICY` so the source reads honestly.
 *
 * @module ai/ai_conqueror
 */

import { makeBC } from './ai_bc.js';
import { BC_POLICY as CONQUEROR_POLICY } from './conquerorPolicyWeights.js';

/**
 * The Conqueror bot move function — the balanced win-objective policy.
 * @param {import('../arena/types.js').BotState} botState
 * @returns {{ from: number, to: number } | null} An attack, or null to end the turn.
 */
export const ai_conqueror = makeBC({ policy: CONQUEROR_POLICY });

export default ai_conqueror;
