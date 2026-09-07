# Daily Conquest leaderboard (Cloudflare Worker + D1)

The shared board behind Daily Conquest. It accepts a finished daily attempt,
**re-simulates the submitted replay against that date's own seed** with the real
game engine and `ai_default`, and records the score it derives — never the score
the client claims.

Everything under `src/` is deployed. The verifier itself lives in the game repo
(`src/game/verifyDailyReplay.js`) and is imported by relative path; wrangler
bundles it along with the engine it pulls in. There is nothing to vendor and no
second copy of the rules to keep in sync.

## API

Base URL is whatever the Worker is deployed to; the client reads it from
`VITE_DAILY_LEADERBOARD_URL` at build time.

### `GET /daily/{YYYY-MM-DD}`

```json
{
  "date": "2026-09-16",
  "entries": [{ "rank": 1, "name": "Ivan", "turns": 14, "at": "2026-09-16T09:41:02.113Z" }],
  "totals": { "finished": 37, "won": 12 }
}
```

Top 50 **wins**, fewest human turns first, earliest submission breaking a tie.
Losses and draws never appear as entries; they only move `totals.finished`. Any
well-formed date is readable, including closed boards.

### `POST /daily/{YYYY-MM-DD}/results`

```json
{ "version": 1, "name": "Ivan", "replay": { "version": 2, "config": {}, "actions": [] } }
```

→ `201`

```json
{ "accepted": true, "won": true, "turns": 14, "rank": 1, "totals": { "finished": 38, "won": 13 } }
```

`rank` is `null` for a loss or a draw.

### Errors

All errors are `{ "error": "<code>", "message": "<player-readable>" }`.

| Status | Code                 | Meaning                                                            |
| ------ | -------------------- | ------------------------------------------------------------------ |
| 400    | `invalid_body`       | Malformed date, oversized body (>64 KB), bad JSON, wrong `version` |
| 400    | `name_rejected`      | Name fails the length/charset rules or is reserved/blocked         |
| 400    | `wrong_board`        | Replay is not this date's board (seed, size, or a handicap)        |
| 400    | `unverifiable`       | Illegal human move, edited opponent turn, or a torn replay         |
| 400    | `not_finished`       | The game was abandoned rather than finished                        |
| 400    | `duplicate`          | You already posted this exact replay to this board                 |
| 400    | `date_closed`        | Not today's or yesterday's board (UTC)                             |
| 429    | `rate_limited`       | 3 accepted submissions already from this address for this board    |
| 404    | `not_found`          | No such endpoint                                                   |
| 405    | `method_not_allowed` | Wrong verb for the route                                           |
| 503    | `unavailable`        | Database error, or `IP_SALT` is not configured                     |

`duplicate` is an addition to the shared v2 contract, which lists the other
codes. A client that doesn't know it should still show the `message`.

### CORS

Only the origins in `ALLOWED_ORIGINS` get an `Access-Control-Allow-Origin`
header; every other origin gets a response the browser refuses. There is no
wildcard — the write endpoint should not be callable from arbitrary pages.
`OPTIONS` returns `204` with the preflight headers.

## What is stored, and what is not

Stored per submission: the display name and the verified `won`/`drew`/`turns`/
`attacks`/`captures`, plus a salted SHA-256 of `CF-Connecting-IP` (to cap
submissions) and a SHA-256 of the replay (to reject the same submitter posting
the same game twice — scoped per address, because two players _can_ produce
identical replays on a fixed seed).

**Not stored:** the replay, the raw address, cookies, or any other identifier.
The address hash is one-way and salted with a secret that never leaves the
Worker, so the table cannot be turned back into a list of who played.

## Anti-cheat, honestly

What the server actually guarantees: the submitted game was played on that
date's real board, every human move was legal, the opponents played the moves
`ai_default` really produces on that board, the game genuinely finished, and the
turn count is the one the engine produced.

What it does **not** guarantee: that a person only played once. That is enforced
client-side in `localStorage` plus the per-address cap here, and the owner
accepts the tradeoff. Someone determined can replay the board offline and submit
their best run.

The name blocklist in `src/names.js` is a speed bump, not moderation. Delete a
bad row by hand:

```sh
wrangler d1 execute dicewars-daily --remote \
  --command "DELETE FROM results WHERE id = 123"
```

## Deploy

From this directory (`server/daily-leaderboard/`). It has its own
`package.json`; `wrangler` is **not** a dependency of the game repo.

```sh
npm install                       # installs wrangler here only
npx wrangler login
```

1. **Create the database** and copy the id it prints into `wrangler.toml`
   (`database_id`):

   ```sh
   npx wrangler d1 create dicewars-daily
   ```

2. **Apply the schema** (safe to re-run):

   ```sh
   npm run migrate
   ```

3. **Set the address salt.** Any long random string; generate one with
   `openssl rand -hex 32`. Submissions are refused with `503` until this exists:

   ```sh
   npx wrangler secret put IP_SALT
   ```

4. **Adjust `ALLOWED_ORIGINS`** in `wrangler.toml` if the game is served from
   somewhere other than `https://ivanlay.com`.

5. **Deploy** and note the `*.workers.dev` URL it prints:

   ```sh
   npm run deploy
   ```

6. **Point the game at it.** Set the GitHub repository variable
   `DAILY_LEADERBOARD_URL` to that URL (no trailing slash). The Pages build
   passes it to Vite as `VITE_DAILY_LEADERBOARD_URL`; with the variable unset,
   the client treats the leaderboard as disabled and the UI hides it, so the
   game keeps working with local results only.

   ```sh
   gh variable set DAILY_LEADERBOARD_URL --body "https://dicewars-daily-leaderboard.<subdomain>.workers.dev"
   ```

### Local development

```sh
npm run dev              # wrangler dev on http://localhost:8787
npm run migrate:local    # apply the schema to the local D1
```

`wrangler dev` has no `CF-Connecting-IP`, so the cap falls back to
`X-Forwarded-For` and then to a single shared bucket. Set `IP_SALT` in a
`.dev.vars` file (git-ignored) for local runs.

### Cost and limits

Verifying one replay re-simulates a whole game — roughly 2–3 ms of CPU on a
20-territory board. That fits the free plan's 10 ms per-request CPU budget, but
not with much room; on a paid plan, uncomment the `[limits] cpu_ms` block in
`wrangler.toml`. Reads are a single indexed query and cost nothing to speak of.

## Tests

The suites live with the game's tests, not here, because they exercise the
Worker against replays produced by the real `GameController`:

```sh
npx vitest run tests/server
```

`tests/server/dailyReplayFixture.js` plays real daily games headlessly;
`tests/server/dailyLeaderboardWorker.test.js` drives `handleRequest` against an
in-memory SQLite database bound as `DB` through the same D1 interface the
Worker uses in production.
