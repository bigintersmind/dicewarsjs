/**
 * Online Tournament — durable-output builders
 *
 * Pure helpers that turn an arena {@link module:arena/arenaRunner.ArenaResult} into the
 * `leaderboard.json` / `tournament-history.json` objects the daily tournament commits and
 * the frontend publishes. Extracted from `run-online-tournament.mjs` so the broken-bot
 * exclusion — the part that keeps a mis-registered bot's meaningless ELO out of the public
 * leaderboard (and out of next-day `initialRatings` seeding) — is unit-testable without the
 * script's file IO, arena run (map generation + games), and community-bot loading. (#53, #92 item 1)
 *
 * @module scripts/lib/online-tournament
 */

import { DEFAULT_RATING } from '../../src/arena/elo.js';

/**
 * Names of bots flagged as broken in an arena result. A flagged bot errored on most of its
 * turns, so its win%/ELO is noise — {@link module:arena/botErrorReport.reportBotErrors} has
 * already warned about it and surfaced it here as `result.flagged`.
 *
 * `result.flagged` is REQUIRED. A run with no broken bots reports `flagged: []`, so a missing
 * field is a contract violation, not "zero broken bots" — and defaulting it away is exactly
 * the silent republish this module exists to prevent (#53). So we throw rather than tolerate
 * it: "no flag pass" must be an explicit decision by the caller, never an accident.
 *
 * @param {{ flagged: Array<{name: string}> }} result
 * @returns {Set<string>}
 * @throws {Error} if `result.flagged` is not an array
 */
export function flaggedNameSet(result) {
  if (!Array.isArray(result.flagged)) {
    throw new Error(
      'online-tournament: result.flagged is missing — refusing to build durable outputs ' +
        'without the broken-bot pass. A missing flag list would silently republish a broken ' +
        "bot's ELO (the #53 masquerade). Pass flagged: [] to assert a clean run."
    );
  }
  return new Set(result.flagged.map(f => f.name));
}

/**
 * Build the persisted leaderboard object.
 *
 * Flagged (broken) bots are EXCLUDED from the published `bots` list. Because the next run
 * seeds `initialRatings` from this file's `bots`, dropping a flagged bot here also stops its
 * corrupted rating from compounding day-over-day — the exact silent-failure class #53 set
 * out to kill, at the one consumer that publishes to users. Surviving bots additionally
 * carry their forced-end counts (`errors`/`invalidMoves`/`maxMovesHit`) for diagnosis.
 *
 * @param {Object} params
 * @param {import('../../src/arena/arenaRunner.js').ArenaResult} params.result
 * @param {{ tournamentCount: number, totalGamesPlayed: number, bots: Array<{name: string, elo: number}> }} params.previousLeaderboard
 * @param {Map<string, string>} params.authorByName - Display name → author ('built-in' default)
 * @param {Array<Object>} params.replayFiles - Replay descriptors to attach
 * @param {string} params.updatedAt - ISO timestamp for this run
 * @returns {Object} Leaderboard object ready to serialize
 */
export function buildLeaderboard({
  result,
  previousLeaderboard,
  authorByName,
  replayFiles,
  updatedAt,
}) {
  const flagged = flaggedNameSet(result);

  return {
    updatedAt,
    tournamentCount: previousLeaderboard.tournamentCount + 1,
    totalGamesPlayed: previousLeaderboard.totalGamesPlayed + result.totalGames,
    bots: result.bots
      .filter(bot => !flagged.has(bot.name))
      .map(bot => {
        const prev = previousLeaderboard.bots.find(b => b.name === bot.name);
        const previousElo = prev ? prev.elo : DEFAULT_RATING;
        return {
          name: bot.name,
          author: authorByName.get(bot.name) ?? 'built-in',
          elo: Math.round(bot.elo),
          previousElo: Math.round(previousElo),
          wins: bot.wins,
          gamesPlayed: bot.gamesPlayed,
          winRate: bot.gamesPlayed > 0 ? +(bot.wins / bot.gamesPlayed).toFixed(3) : 0,
          avgPlacement: bot.avgPlacement,
          attackWinRate: bot.attackWinRate,
          errors: bot.errors,
          invalidMoves: bot.invalidMoves,
          maxMovesHit: bot.maxMovesHit,
        };
      }),
    replays: replayFiles,
  };
}

/**
 * Build one `tournament-history.json` entry.
 *
 * Standings exclude flagged bots (mirroring the leaderboard) and carry each surviving bot's
 * `errors` count. The excluded bots are NOT silently dropped from the record: they are kept
 * under a separate `flagged[]` field (name + counts + fraction) so a run's exclusions stay
 * durably diagnosable without polluting the ELO-bearing standings.
 *
 * @param {Object} params
 * @param {import('../../src/arena/arenaRunner.js').ArenaResult} params.result
 * @param {string} params.date - YYYY-MM-DD for this run
 * @param {number} params.botCount - Size of the field that ran (all seats, flagged included)
 * @returns {Object} History entry ready to append
 */
export function buildHistoryEntry({ result, date, botCount }) {
  const flagged = flaggedNameSet(result); // throws if result.flagged is absent

  const standings = result.bots
    .filter(b => !flagged.has(b.name))
    .map(b => ({
      name: b.name,
      elo: Math.round(b.elo),
      wins: b.wins,
      errors: b.errors,
    }));

  return {
    date,
    gamesPlayed: result.totalGames,
    failedGames: result.failedGames,
    botCount,
    // Champion is the top surviving bot: a flagged bot can't legitimately hold the crown.
    champion: standings.length > 0 ? standings[0].name : null,
    standings,
    flagged: result.flagged.map(f => ({
      name: f.name,
      errors: f.errors,
      invalidMoves: f.invalidMoves,
      maxMovesHit: f.maxMovesHit ?? 0,
      errorFraction: +f.errorFraction.toFixed(3),
    })),
  };
}
