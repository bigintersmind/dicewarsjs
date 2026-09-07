/**
 * D1 access for the Daily Conquest leaderboard.
 *
 * Every statement the Worker issues lives here, as a named constant in
 * {@link SQL}, and nothing outside this module builds SQL. That is what lets the
 * test suite bind a plain SQLite database to the same `DB` interface and still
 * be exercising the real queries.
 *
 * Two ordering rules run through all of it:
 *
 * - **Ranking is wins only**, fewest human turns first, earliest submission
 *   breaking a tie. `created_at` has millisecond resolution, which two
 *   submissions can share, so `id` — monotonic in insert order — is the final
 *   tiebreaker. `created_at` is what the API returns; `id` is what makes the
 *   order total.
 * - **Nothing here trusts a client number.** The caller passes only values that
 *   came out of `verifyDailyReplay`.
 *
 * @module server/daily-leaderboard/db
 */

/** Rows returned by `GET /daily/:date`. */
export const LEADERBOARD_LIMIT = 50;

/** Every statement the Worker runs, named. */
export const SQL = {
  insertResult: `
    INSERT INTO results
      (date, name, won, drew, turns, attacks, captures, ip_hash, replay_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  totals: `
    SELECT COUNT(*) AS finished, COALESCE(SUM(won), 0) AS won
    FROM results WHERE date = ?`,

  topWins: `
    SELECT name, turns, created_at
    FROM results
    WHERE date = ? AND won = 1
    ORDER BY turns ASC, created_at ASC, id ASC
    LIMIT ?`,

  betterThan: `
    SELECT COUNT(*) AS better
    FROM results
    WHERE date = ? AND won = 1
      AND (turns < ? OR (turns = ? AND (created_at < ? OR (created_at = ? AND id < ?))))`,

  ipCount: `SELECT count FROM submissions_per_ip WHERE date = ? AND ip_hash = ?`,

  bumpIpCount: `
    INSERT INTO submissions_per_ip (date, ip_hash, count) VALUES (?, ?, 1)
    ON CONFLICT (date, ip_hash) DO UPDATE SET count = count + 1`,

  findReplay: `SELECT id FROM results WHERE date = ? AND ip_hash = ? AND replay_hash = ? LIMIT 1`,
};

/**
 * Finished-attempt counts for a board.
 *
 * @param {D1Database} db
 * @param {string} date
 * @returns {Promise<{finished: number, won: number}>}
 */
export async function readTotals(db, date) {
  const row = await db.prepare(SQL.totals).bind(date).first();
  return { finished: Number(row?.finished ?? 0), won: Number(row?.won ?? 0) };
}

/**
 * The board itself: the fastest wins for a date, already ranked.
 *
 * @param {D1Database} db
 * @param {string} date
 * @param {number} [limit=LEADERBOARD_LIMIT]
 * @returns {Promise<{rank: number, name: string, turns: number, at: string}[]>}
 */
export async function readTopWins(db, date, limit = LEADERBOARD_LIMIT) {
  const { results } = await db.prepare(SQL.topWins).bind(date, limit).all();
  return (results ?? []).map((row, i) => ({
    rank: i + 1,
    name: row.name,
    turns: Number(row.turns),
    at: row.created_at,
  }));
}

/**
 * Has this submitter already posted this exact game to this board?
 *
 * Scoped to the submitter (see the schema note): two people can legitimately
 * produce identical replays on a fixed seed, so global replay uniqueness would
 * refuse an honest second player.
 *
 * @param {D1Database} db
 * @param {string} date
 * @param {string} ipHash
 * @param {string} replayHash
 * @returns {Promise<boolean>}
 */
export async function replayAlreadySubmitted(db, date, ipHash, replayHash) {
  const row = await db.prepare(SQL.findReplay).bind(date, ipHash, replayHash).first();
  return row != null;
}

/**
 * Accepted submissions so far from one (salted-hashed) address on one board.
 *
 * @param {D1Database} db
 * @param {string} date
 * @param {string} ipHash
 * @returns {Promise<number>}
 */
export async function readIpCount(db, date, ipHash) {
  const row = await db.prepare(SQL.ipCount).bind(date, ipHash).first();
  return Number(row?.count ?? 0);
}

/**
 * Record a verified result and charge it to the submitter's daily allowance.
 *
 * The counter is bumped only here, after the insert, so a rejected submission
 * (bad name, unverifiable replay) never eats an attempt.
 *
 * @param {D1Database} db
 * @param {Object} entry
 * @returns {Promise<{id: number, createdAt: string}>}
 */
export async function insertResult(db, entry) {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const inserted = await db
    .prepare(SQL.insertResult)
    .bind(
      entry.date,
      entry.name,
      entry.won ? 1 : 0,
      entry.drew ? 1 : 0,
      entry.turns,
      entry.attacks,
      entry.captures,
      entry.ipHash,
      entry.replayHash,
      createdAt
    )
    .run();
  await db.prepare(SQL.bumpIpCount).bind(entry.date, entry.ipHash).run();
  return { id: Number(inserted?.meta?.last_row_id ?? 0), createdAt };
}

/**
 * Where a just-inserted win sits on the board.
 *
 * @param {D1Database} db
 * @param {string} date
 * @param {{id: number, turns: number, createdAt: string}} entry
 * @returns {Promise<number>} 1-based rank
 */
export async function rankOf(db, date, entry) {
  const row = await db
    .prepare(SQL.betterThan)
    .bind(date, entry.turns, entry.turns, entry.createdAt, entry.createdAt, entry.id)
    .first();
  return Number(row?.better ?? 0) + 1;
}
