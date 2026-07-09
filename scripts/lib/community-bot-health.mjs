/**
 * Community Bot Health Check
 *
 * A crashing bot must not crash a tournament, so the engine deliberately swallows a
 * bot's throw into a per-turn counter (`runBotDirect` → `runBotTurn` → `botStats`) and
 * lets the match complete normally. The side effect is that a fully-broken bot — one
 * that throws every turn, or submits an illegal move every turn — finishes `runMatch`
 * without ever throwing out of it, so a validator that only catches `runMatch` throwing
 * reports PASS. That is the #148 gap: the CI validator gating community PRs was the one
 * consumer not reading those counters.
 *
 * This pure helper reads the counters `runMatch` surfaces on `result.botStats` and
 * decides whether the match revealed a broken bot rather than a merely losing one. It
 * lives in `scripts/lib/` (pure + unit-tested) so the gate can't silently rot, mirroring
 * `tournament-field.mjs`. Two independent gates:
 *
 *   1. `errors > 0`          — a thrown exception during a validation match is never
 *                              legitimate (a code bug, not a strategy), so any throw fails.
 *   2. `reportBotErrors` flag — the #53 masquerade (a bot that only ever submits invalid
 *                              moves lands zero attacks and scores a clean low win%). Reused
 *                              directly from the ranking pipeline so the threshold can't drift.
 *
 * @module scripts/lib/community-bot-health
 */

import { reportBotErrors } from '../../src/arena/botErrorReport.js';

/**
 * @typedef {Object} BotMatchHealth
 * @property {boolean}      ok           - True when the bot showed no signs of breakage.
 * @property {number}       errors       - Turns that ended in a thrown exception.
 * @property {number}       invalidMoves - Illegal moves attempted.
 * @property {number}       attacksMade  - Valid attacks landed.
 * @property {string|null}  reason       - Human-readable failure reason (null when ok).
 */

/**
 * Assess whether a validation match revealed a broken community bot.
 *
 * @param {import('../../src/arena/matchRunner.js').MatchResult} result - A `runMatch` result.
 * @param {string} botName - Name of the community bot within `result.botStats`.
 * @returns {BotMatchHealth}
 */
export function assessBotMatchHealth(result, botName) {
  const stat = result.botStats.find(s => s.name === botName);
  if (!stat) {
    // Fail loud: a missing stat is a programming error (wrong name, or a refactor of how
    // bots are keyed), and defaulting it to healthy would let the very rot this gate exists
    // to prevent slip through as a clean PASS. The sole caller wraps this in the runMatch
    // try/catch, so a throw here fails the bot closed — the safe direction for a merge gate.
    throw new Error(
      `assessBotMatchHealth: bot "${botName}" not found in result.botStats ` +
        `(names: ${result.botStats.map(s => s.name).join(', ') || '<none>'})`
    );
  }
  const { errors, invalidMoves, attacksMade } = stat;

  // Gate 2: reuse the ranking-side masquerade detector rather than invent a threshold.
  // Swallow its warnings — we surface our own message below.
  const flagged = reportBotErrors([{ name: botName, errors, attacks: attacksMade, invalidMoves }], {
    warn: () => {},
  });

  let reason = null;
  if (errors > 0) {
    // Gate 1: any thrown exception is a code bug, never legitimate losing. Deliberately
    // stricter than validate-bot.mjs (the single-bot dev tool), which only WARNs on
    // errors > 0 — a merge gate should reject a throwing bot, not wave it through.
    reason =
      `bot threw during the test match — ${errors} turn(s) ended in an error ` +
      `(${invalidMoves} invalid move(s), ${attacksMade} attack(s) landed). ` +
      `A bot that throws is broken, not losing.`;
  } else if (flagged.length > 0) {
    const pct = (flagged[0].errorFraction * 100).toFixed(1);
    reason =
      `bot submitted ${invalidMoves} invalid move(s) and landed only ${attacksMade} ` +
      `valid attack(s) (error fraction ${pct}%). A bot that never makes a valid move ` +
      `is broken or mis-registered, not losing.`;
  }

  return { ok: reason === null, errors, invalidMoves, attacksMade, reason };
}
