/**
 * Bot Error Report
 *
 * Turn-level error observability for the ranking pipeline.
 *
 * `runMatch` already counts, per bot per match, the forced-end signals — `errors`
 * (the bot threw, or `applyAction`/`END_TURN` threw), `invalidMoves`, and
 * `maxMovesHit` — and surfaces them on `botStats`. But a bot that errors on *every*
 * turn never throws out of `runMatch`: `runBotDirect` swallows the throw into a
 * counter and the match completes normally. So a fully-broken bot just shows up as a
 * clean low win% / low ELO — structurally indistinguishable from a bot that
 * legitimately loses every game. That is exactly how the misleading "BC 0.0% win
 * parity" row shipped (a registration bug, #52) and went unnoticed by the ranking
 * pipeline (#53).
 *
 * The data + validation pipelines already guard this class — `forcedEndReason` in
 * scripts/lib/selfplay-core.mjs (D-14) quarantines training games, and
 * scripts/validate-bot.mjs downgrades a community bot to a warning. This helper closes
 * the matching gap on the *ranking* side: given the per-bot error/attack totals a
 * ranking run has accumulated, it warns loudly about any bot whose turn-level error
 * fraction exceeds a threshold, so a broken bot can't masquerade as a meaningful
 * measurement.
 *
 * @module arena/botErrorReport
 */

/**
 * Default turn-level error fraction above which a bot's ranking is treated as
 * unreliable. A bot that errors on most of its turns isn't losing — it's broken, and
 * its win% / ELO is noise. See {@link reportBotErrors}.
 */
export const ERROR_FRACTION_THRESHOLD = 0.5;

/**
 * @typedef {Object} BotErrorTotals
 * @property {string} name           - Bot name
 * @property {number} errors         - Total turns that ended in an error across the run
 * @property {number} attacks        - Total attacks made (applied) across the run — the
 *   `attacksMade` counter, not the `attacksWon` subset
 * @property {number} [invalidMoves] - Total invalid moves attempted. Folded into the flag
 *   decision (a bot that only ever submits invalid moves never lands an attack, so the
 *   errors fraction can't see it — see {@link reportBotErrors}) and printed in the message.
 * @property {number} [maxMovesHit]  - Total turns force-ended by the per-turn move cap.
 *   NOT a breakage signal on its own — a legitimately aggressive bot reaches the cap only by
 *   making many valid attacks — so it is deliberately excluded from the flag decision.
 */

/**
 * @typedef {BotErrorTotals & {errorFraction: number}} FlaggedBot
 */

/**
 * Warn loudly about bots whose turn-level error fraction exceeds `threshold`.
 *
 * The primary metric is `errors / (errors + attacks)` — the fraction the #53 issue calls
 * out: a bot that makes no attacks and all errors scores 1.0, a healthy bot scores 0.
 *
 * That fraction has a blind spot, though: a bot that errors via *invalid moves* rather than
 * throws never lands an attack, so its denominator is 0 and the fraction is undefined. A bot
 * mis-registered into the wrong coordinate space submits an illegal `{from,to}` every turn —
 * `invalidMoves` climbs while `errors` and `attacks` stay 0 — which is the same masquerade as
 * a 100%-error bot (#53), just reached through a different forced-end signal. So when the
 * errors-fraction denominator is 0 we split the two no-attack cases: a bot that also made no
 * invalid moves never acted at all (a voluntary all-STOP/pass bot — degenerate but not broken)
 * and is skipped, whereas a bot with `invalidMoves > 0` attempted to act every turn and never
 * once landed a valid attack, so it is flagged at fraction 1.0.
 *
 * @param {BotErrorTotals[]} totals - Per-bot error/attack totals for the whole run
 * @param {Object} [options]
 * @param {number} [options.threshold=ERROR_FRACTION_THRESHOLD] - Fraction above which to warn
 * @param {string} [options.label='[Arena]'] - Log prefix, matching the caller's other logs
 * @param {(message: string) => void} [options.warn=console.warn] - Warn sink (injectable for tests)
 * @returns {FlaggedBot[]} Bots that exceeded the threshold, sorted by fraction descending
 */
export function reportBotErrors(totals, options = {}) {
  const { threshold = ERROR_FRACTION_THRESHOLD, label = '[Arena]', warn = console.warn } = options;

  const flagged = [];
  for (const t of totals) {
    const errors = t.errors || 0;
    const attacks = t.attacks || 0;
    const invalidMoves = t.invalidMoves || 0;
    const denom = errors + attacks;
    let errorFraction;
    if (denom === 0) {
      // No errors and no landed attacks. If it also made no invalid moves it never acted
      // (a voluntary all-STOP/pass bot) — degenerate but not broken, so skip it. A bot that
      // DID submit invalid moves every turn never landed a single valid attack: that is the
      // #53 masquerade reached via the invalid-move signal, so treat it as fully broken.
      if (invalidMoves === 0) continue;
      errorFraction = 1;
    } else {
      errorFraction = errors / denom;
    }
    if (errorFraction > threshold) {
      flagged.push({ ...t, errors, attacks, invalidMoves, errorFraction });
    }
  }

  flagged.sort((a, b) => b.errorFraction - a.errorFraction);

  for (const f of flagged) {
    const pct = (f.errorFraction * 100).toFixed(1);
    warn(
      `${label} bot "${f.name}": ${f.errors} turn(s) ended in an error and ${f.invalidMoves} ` +
        `invalid move(s) attempted, vs ${f.attacks} attack(s) landed (error fraction ${pct}%). ` +
        `Its win% / ELO is NOT a meaningful measurement — this looks like a broken or ` +
        `mis-registered bot, not legitimate losing.`
    );
  }

  return flagged;
}
