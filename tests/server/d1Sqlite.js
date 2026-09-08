/**
 * An in-memory stand-in for the Worker's D1 binding.
 *
 * It implements only the slice of the D1 API `server/daily-leaderboard/src/db.js`
 * uses — `prepare(sql).bind(...).first() / .all() / .run()`, plus `batch()` —
 * on top of Node's built-in SQLite. Real SQL against a real SQLite engine, so
 * the schema, the indexes, the conditional counter writes and the ordering
 * clauses are genuinely exercised; only the network hop and Cloudflare's wire
 * format are faked.
 *
 * `node:sqlite` is a Node built-in (unflagged since 22.13, and CI pins 22.x), so
 * this adds no dependency to the repo. It prints one ExperimentalWarning per
 * run, which is the whole cost.
 *
 * What it deliberately does NOT model, so a test does not read more into a pass
 * than is there:
 *
 * - **D1's error wrapping.** A constraint failure surfaces here as `node:sqlite`
 *   phrases it; real D1 wraps it (`D1_ERROR: …`, sometimes only on `.cause`).
 *   `isUniqueViolation` is therefore pinned against BOTH shapes explicitly in
 *   the Worker suite rather than being trusted to this shim's wording.
 * - **Connection isolation.** There is one connection, so a `prepare(...).run()`
 *   outside a batch can execute INSIDE an open batch transaction — impossible on
 *   D1, where the batch has a connection of its own. Batches are serialized
 *   below to keep the collision from being worse than that.
 * - **Real concurrency.** Everything here is synchronous under the hood, so the
 *   suite's "arrive together" tests exercise the SQL predicates that make the
 *   caps safe, not a genuine race.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(
  new URL('../../server/daily-leaderboard/schema.sql', import.meta.url)
);

/**
 * Wrap a SQLite database in the D1 interface.
 *
 * @param {import('node:sqlite').DatabaseSync} sqlite
 * @returns {{prepare: (sql: string) => Object}} D1-shaped binding
 */
function asD1(sqlite) {
  /*
   * Batches are serialized through this chain. `node:sqlite` has one connection
   * and no nested transactions, so two `batch()` calls interleaving at an await
   * would collide on BEGIN — which a real D1, with its own connection pool,
   * would not. Serializing here keeps the fake's failure modes to D1's.
   */
  let batches = Promise.resolve();

  const runners = (statement, params) => ({
    /** D1 returns the first row, or null — node:sqlite returns undefined. */
    first: async () => statement.get(...params) ?? null,
    all: async () => ({ results: statement.all(...params), success: true }),
    run: async () => {
      const info = statement.run(...params);
      return {
        success: true,
        meta: {
          last_row_id: Number(info.lastInsertRowid),
          changes: Number(info.changes),
        },
      };
    },
  });

  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind: (...params) => runners(statement, params),
        ...runners(statement, []),
      };
    },
    /**
     * D1's `batch`: the statements run in order inside one transaction, and one
     * failure rolls the whole thing back. The atomicity is the part under test
     * — an insert whose counter bump throws must not survive — so this is a
     * real SQLite transaction, not a loop.
     */
    batch(statements) {
      const run = batches.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec('COMMIT');
          return results;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
      });
      batches = run.then(
        () => {},
        () => {}
      );
      return run;
    },
  };
}

/**
 * A fresh, empty leaderboard database with the production schema applied.
 *
 * @returns {{DB: Object, sqlite: import('node:sqlite').DatabaseSync, close: () => void}}
 */
export function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return { DB: asD1(sqlite), sqlite, close: () => sqlite.close() };
}
