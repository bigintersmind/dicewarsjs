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
 * - **A limit is enforced by the write, never by a read.** Both counters are
 *   charged with a single conditional statement whose `changes` count IS the
 *   verdict, so N requests racing on one address cannot each read an under-cap
 *   value and each go through.
 *
 * @module server/daily-leaderboard/db
 */

/** Rows returned by `GET /daily/:date`. */
export const LEADERBOARD_LIMIT = 50;

/**
 * Accepted submissions one address may add to one board. Small on purpose: the
 * client already decides which attempt is official, and this is only here to
 * stop one connection filling the board.
 */
export const MAX_SUBMISSIONS_PER_IP = 3;

/**
 * Submission ATTEMPTS one address may make on one board, charged before the
 * replay is verified — the bound on how much CPU an address can spend.
 *
 * Four times the accepted cap, which leaves an honest player room to lose a
 * response and retry and still post their three results, while capping a
 * hostile address at 12 verifications a day per board.
 */
export const MAX_REQUESTS_PER_IP = 12;

/** Every statement the Worker runs, named. */
export const SQL = {
  /*
   * Conditional on the address's accepted count, so the cap is applied by the
   * insert itself. `INSERT ... SELECT ... WHERE` inserts zero rows when the
   * predicate is false, which surfaces as `meta.changes === 0` — that, not a
   * prior SELECT, is what tells the caller it was refused.
   *
   * The COALESCE wraps the SUBQUERY, not the column: a scalar subquery over no
   * rows is NULL, and `NULL < 3` is NULL, so an address with no counter row yet
   * — every first-time submitter — would silently insert nothing.
   */
  insertResult: `
    INSERT INTO results
      (date, name, won, drew, turns, attacks, captures, ip_hash, replay_hash, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE COALESCE(
      (SELECT count FROM submissions_per_ip WHERE date = ? AND ip_hash = ?), 0
    ) < ?`,

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

  requestCount: `SELECT count FROM requests_per_ip WHERE date = ? AND ip_hash = ?`,

  /*
   * The two counter bumps. Both refuse in SQL rather than reporting a number to
   * be compared afterwards: the `WHERE` on `DO UPDATE` makes the whole
   * read-compare-increment one atomic statement, and `changes` is 0 exactly
   * when the address was already at its cap. Columns are qualified so the
   * predicate reads the stored row, never `excluded`.
   */
  bumpIpCount: `
    INSERT INTO submissions_per_ip (date, ip_hash, count) VALUES (?, ?, 1)
    ON CONFLICT (date, ip_hash)
    DO UPDATE SET count = submissions_per_ip.count + 1
    WHERE submissions_per_ip.count < ?`,

  bumpRequestCount: `
    INSERT INTO requests_per_ip (date, ip_hash, count) VALUES (?, ?, 1)
    ON CONFLICT (date, ip_hash)
    DO UPDATE SET count = requests_per_ip.count + 1
    WHERE requests_per_ip.count < ?`,

  /*
   * Selects the whole row, not just its existence: a re-post of a game this
   * submitter already landed is answered FROM this row (see `alreadyPosted` in
   * index.js), so a retry after a lost response gets the same numbers the
   * original insert returned instead of a dead-end `duplicate`.
   */
  findReplay: `
    SELECT id, name, won, turns, created_at
    FROM results
    WHERE date = ? AND ip_hash = ? AND replay_hash = ?
    LIMIT 1`,
};

/** Did a write actually change a row? The verdict every conditional bump gives. */
function changed(result) {
  return Number(result?.meta?.changes ?? 0) > 0;
}

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
 * The row this submitter already stored for this exact game, if there is one.
 *
 * Scoped to the submitter (see the schema note): two people can legitimately
 * produce identical replays on a fixed seed, so global replay uniqueness would
 * refuse an honest second player.
 *
 * @param {D1Database} db
 * @param {string} date
 * @param {string} ipHash
 * @param {string} replayHash
 * @returns {Promise<{id: number, name: string, won: boolean, turns: number,
 *   createdAt: string}|null>}
 */
export async function findSubmittedResult(db, date, ipHash, replayHash) {
  const row = await db.prepare(SQL.findReplay).bind(date, ipHash, replayHash).first();
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    won: Number(row.won) === 1,
    turns: Number(row.turns),
    createdAt: row.created_at,
  };
}

/**
 * Accepted submissions so far from one (salted-hashed) address on one board.
 *
 * Read-only, and deliberately NOT what enforces the cap — {@link insertResult}
 * does that in the write. It exists so the tests can state what the counters
 * hold after a run.
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
 * Submission attempts so far from one address on one board. Same caveat as
 * {@link readIpCount}: a read, not the rule.
 *
 * @param {D1Database} db
 * @param {string} date
 * @param {string} ipHash
 * @returns {Promise<number>}
 */
export async function readRequestCount(db, date, ipHash) {
  const row = await db.prepare(SQL.requestCount).bind(date, ipHash).first();
  return Number(row?.count ?? 0);
}

/**
 * Charge one submission ATTEMPT to an address, before anything expensive runs.
 *
 * One conditional statement: it increments and refuses in the same write, so
 * ten simultaneous requests from one address get ten separate verdicts rather
 * than ten copies of the same stale read.
 *
 * @param {D1Database} db
 * @param {string} date
 * @param {string} ipHash
 * @param {number} [limit=MAX_REQUESTS_PER_IP]
 * @returns {Promise<boolean>} False when the address is already at its cap.
 */
export async function chargeRequest(db, date, ipHash, limit = MAX_REQUESTS_PER_IP) {
  return changed(await db.prepare(SQL.bumpRequestCount).bind(date, ipHash, limit).run());
}

/**
 * Record a verified result and charge it to the submitter's accepted allowance.
 *
 * Both statements go through `db.batch`, which D1 runs as one transaction, and
 * both are conditional on the same pre-batch count — so the row and the tally
 * it is charged against land together or not at all. Two consequences worth
 * naming: a bump that throws takes the row down with it (it used to leave a
 * free slot behind), and a submitter already at the cap inserts nothing, which
 * comes back as `accepted: false` rather than as a row that was never counted.
 *
 * A `UNIQUE constraint failed` here is the duplicate-replay index racing with
 * the handler's own check; the caller maps it to `duplicate`.
 *
 * @param {D1Database} db
 * @param {Object} entry
 * @param {number} [limit=MAX_SUBMISSIONS_PER_IP]
 * @returns {Promise<{accepted: boolean, id: number, createdAt: string}>}
 */
export async function insertResult(db, entry, limit = MAX_SUBMISSIONS_PER_IP) {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const [inserted] = await db.batch([
    db
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
        createdAt,
        entry.date,
        entry.ipHash,
        limit
      ),
    db.prepare(SQL.bumpIpCount).bind(entry.date, entry.ipHash, limit),
  ]);

  if (!changed(inserted)) return { accepted: false, id: 0, createdAt };
  return { accepted: true, id: Number(inserted?.meta?.last_row_id ?? 0), createdAt };
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
