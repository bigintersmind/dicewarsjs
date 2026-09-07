-- Daily Conquest shared leaderboard — D1 schema.
--
-- Apply with:  npm run migrate        (remote)
--              npm run migrate:local  (wrangler dev's local D1)
--
-- Every statement is IF NOT EXISTS, so re-applying it is safe.

-- One verified attempt. The replay itself is NOT stored: only the numbers the
-- re-simulation produced, plus two hashes used for limits, never for identity.
CREATE TABLE IF NOT EXISTS results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL,             -- board date, YYYY-MM-DD UTC
  name        TEXT    NOT NULL,             -- normalized display name
  won         INTEGER NOT NULL,             -- 0/1 — only wins are ranked
  drew        INTEGER NOT NULL DEFAULT 0,   -- 0/1 — turn-cap draw
  turns       INTEGER NOT NULL,             -- human turns; the ranking key
  attacks     INTEGER NOT NULL,
  captures    INTEGER NOT NULL,
  ip_hash     TEXT    NOT NULL,             -- salted SHA-256 of CF-Connecting-IP
  replay_hash TEXT    NOT NULL,             -- SHA-256 of the submitted replay
  created_at  TEXT    NOT NULL              -- ISO 8601; ties break on id
);

-- Serves both the board query (date + won, ordered by turns then created_at)
-- and the rank count, which filters on exactly those columns.
CREATE INDEX IF NOT EXISTS idx_results_board ON results (date, won, turns, created_at);

-- One submitter re-posting the same game to the same board is a duplicate, not
-- a second attempt (usually a retry after a lost response). Scoped by ip_hash on
-- purpose: on a fixed seed two different people CAN produce byte-identical
-- replays — a short forced loss especially — and the second of them must not be
-- turned away. Enforced in SQL as well as in the handler so a race can't slip
-- two in.
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_replay ON results (date, ip_hash, replay_hash);

-- Accepted submissions per address per board. Bumped only after a successful
-- insert, so a rejected submission never costs an attempt.
CREATE TABLE IF NOT EXISTS submissions_per_ip (
  date    TEXT    NOT NULL,
  ip_hash TEXT    NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, ip_hash)
);
