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
 * the matching gap on the *ranking* side: given the per-bot error/turn/attack totals a
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
 * @property {number} [turns]        - Total turns the bot took across the run — the
 *   denominator of the error fraction (`errors / turns`, a true per-turn error rate; see
 *   {@link reportBotErrors}). Omitting it (or 0) means "took no turns" and the bot is skipped
 *   unless the never-landed-an-attack masquerade branch catches it.
 * @property {number} [attacks]      - Total attacks made (applied) across the run — the
 *   `attacksMade` counter, not the `attacksWon` subset. Used only to detect the
 *   never-landed-a-valid-attack masquerade (`attacks === 0`), no longer the denominator.
 * @property {number} [invalidMoves] - Total invalid moves attempted. Folded into the flag
 *   decision (a bot that only ever submits invalid moves never lands an attack, so the
 *   per-turn errors rate reads 0 despite the bot being broken — see {@link reportBotErrors})
 *   and printed in the message.
 * @property {number} [maxMovesHit]  - Total turns force-ended by the per-turn move cap.
 *   NOT a breakage signal on its own — a legitimately aggressive bot reaches the cap only by
 *   making many valid attacks — so it is deliberately excluded from the flag decision.
 */

/**
 * @typedef {BotErrorTotals & {errorFraction: number}} FlaggedBot
 */

/**
 * Warn loudly about bots whose per-turn error fraction exceeds `threshold`.
 *
 * The primary metric is `errors / turns` — a true per-turn error rate: a bot that errors on
 * every turn scores 1.0, one that never errors scores 0. This is the #92-item-4 fix for the
 * original `errors / (errors + attacks)`, which mixed units — `errors` is tallied at most once
 * per turn (the move loop `break`s on the first error) while `attacks` counts individual
 * applied attacks (up to ~100/turn), so healthy per-attack volume dominated the denominator
 * and the nominal 0.5 threshold behaved like an ~80% turn-level one, letting a half-broken bot
 * slip through ranked as a real measurement.
 *
 * That per-turn rate has a blind spot, though: a bot that fails via *invalid moves* rather than
 * throws never lands an attack yet never throws either, so `errors` (and thus `errors / turns`)
 * stays 0 despite the bot being fully broken. A bot mis-registered into the wrong coordinate
 * space submits an illegal `{from,to}` every turn — `invalidMoves` climbs while `errors` and
 * `attacks` stay 0 — the same masquerade as a 100%-error bot (#53), reached through a different
 * forced-end signal. So we handle the never-landed-a-valid-attack case (`attacks === 0`) first,
 * before the per-turn rate: a bot that also never threw and never submitted an invalid move
 * simply never acted (a voluntary all-STOP/pass bot — degenerate but not broken) and is skipped;
 * one that threw or submitted invalid moves yet never once landed a valid attack is flagged at
 * fraction 1.0. Bots that did land at least one attack are graded purely on `errors / turns`.
 *
 * @param {BotErrorTotals[]} totals - Per-bot error/turn/attack totals for the whole run
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
    const turns = t.turns || 0;
    const attacks = t.attacks || 0;
    const invalidMoves = t.invalidMoves || 0;

    let errorFraction;
    if (attacks === 0) {
      // Never landed a single valid attack. If it also never threw and never submitted an
      // invalid move it never acted at all (a voluntary all-STOP/pass bot) — degenerate but
      // not broken, so skip it. Otherwise every turn it either threw or played an illegal
      // move and never once landed a valid attack: the #53 masquerade, which the per-turn
      // error rate can't grade for the invalid-move variant (`errors` stays 0). Flag at 1.0.
      if (errors === 0 && invalidMoves === 0) continue;
      errorFraction = 1;
    } else {
      // Landed at least one valid attack ⇒ it took at least one real turn (turns > 0), so
      // grade it on the true per-turn error rate. The `turns > 0` guard is belt-and-suspenders
      // against malformed totals (attacks without a turn count) — never divide by zero.
      errorFraction = turns > 0 ? errors / turns : 0;
    }
    if (errorFraction > threshold) {
      flagged.push({ ...t, errors, turns, attacks, invalidMoves, errorFraction });
    }
  }

  flagged.sort((a, b) => b.errorFraction - a.errorFraction);

  for (const f of flagged) {
    const pct = (f.errorFraction * 100).toFixed(1);
    warn(
      `${label} bot "${f.name}": errored on ${f.errors} of ${f.turns} turn(s) and attempted ` +
        `${f.invalidMoves} invalid move(s), vs ${f.attacks} attack(s) landed (error fraction ` +
        `${pct}%). Its win% / ELO is NOT a meaningful measurement — this looks like a broken ` +
        `or mis-registered bot, not legitimate losing.`
    );
  }

  return flagged;
}
