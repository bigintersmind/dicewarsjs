/**
 * An in-memory stand-in for the Worker's D1 binding.
 *
 * It implements only the slice of the D1 API `server/daily-leaderboard/src/db.js`
 * uses — `prepare(sql).bind(...).first() / .all() / .run()` — on top of Node's
 * built-in SQLite. Real SQL against a real SQLite engine, so the schema, the
 * indexes and the ordering clauses are genuinely exercised; only the network
 * hop and Cloudflare's wire format are faked.
 *
 * `node:sqlite` is a Node built-in (unflagged since 22.13, and CI pins 22.x), so
 * this adds no dependency to the repo. It prints one ExperimentalWarning per
 * run, which is the whole cost.
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
