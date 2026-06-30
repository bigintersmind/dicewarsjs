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
 * @property {number} [invalidMoves] - Total invalid moves attempted (context for the message)
 * @property {number} [maxMovesHit]  - Total turns force-ended by the per-turn move cap
 */

/**
 * @typedef {BotErrorTotals & {errorFraction: number}} FlaggedBot
 */

/**
 * Warn loudly about bots whose turn-level error fraction exceeds `threshold`.
 *
 * The fraction is `errors / (errors + attacks)` — the metric the #53 issue calls out:
 * a bot that makes no attacks and all errors scores 1.0, a healthy bot scores 0.
 * Bots that never acted (no errors and no attacks — e.g. a bot that always voluntarily
 * passes) have an undefined fraction and are skipped: an all-STOP bot is degenerate but
 * not *broken*, and is not the failure mode this guards.
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
    const denom = errors + attacks;
    if (denom === 0) continue; // never acted (pure pass) — no error signal to report
    const errorFraction = errors / denom;
    if (errorFraction > threshold) {
      flagged.push({ ...t, errors, attacks, errorFraction });
    }
  }

  flagged.sort((a, b) => b.errorFraction - a.errorFraction);

  for (const f of flagged) {
    const pct = (f.errorFraction * 100).toFixed(1);
    warn(
      `${label} bot "${f.name}": ${f.errors} of its turns ended in an error vs ${f.attacks} ` +
        `attack(s) made (error fraction ${pct}%). Its win% / ELO is NOT a meaningful measurement ` +
        `— this looks like a broken or mis-registered bot, not legitimate losing.`
    );
  }

  return flagged;
}
