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

Re-posting a game this address already landed is **idempotent**: the same name
gets `200` with the same body (rank recomputed from the stored row) and nothing
is inserted, so a retry after a lost response finishes cleanly. A _different_
name on the same replay is `400 duplicate`.

### Errors

All errors are `{ "error": "<code>", "message": "<player-readable>" }`.

| Status | Code                 | Meaning                                                                  |
| ------ | -------------------- | ------------------------------------------------------------------------ |
| 400    | `invalid_body`       | Malformed date, bad JSON, JSON nested >32 deep, wrong `version`          |
| 400    | `name_rejected`      | Name fails the length/charset rules                                      |
| 400    | `name_blocked`       | Name is well formed but reserved or on the blocklist                     |
| 400    | `wrong_board`        | Replay is not this date's board (seed, size, or a handicap)              |
| 400    | `unverifiable`       | Illegal human move, edited opponent turn, or a torn replay               |
| 400    | `not_finished`       | The game was abandoned rather than finished                              |
| 400    | `duplicate`          | Someone at this address already posted this replay under another name    |
| 400    | `date_closed`        | Not today's or yesterday's board (UTC)                                   |
| 403    | `forbidden`          | POST without a listed `Origin` header                                    |
| 415    | `invalid_body`       | POST whose `Content-Type` is not `application/json`                      |
| 400    | `invalid_body`       | Body over 64 KB, or with no `Content-Length` at all (bytes, not chars)   |
| 429    | `rate_limited`       | 12 submission attempts, or 3 accepted results, already from this address |
| 404    | `not_found`          | No such endpoint                                                         |
| 405    | `method_not_allowed` | Wrong verb for the route                                                 |
| 503    | `unavailable`        | Database error, or `IP_SALT` is not configured                           |

Every code above has a player-facing sentence in `LEADERBOARD_MESSAGES`
(`src/game/dailyLeaderboard.js`), which is the client's own copy — the `message`
here is never rendered verbatim for a code the client knows. A code it does not
know falls back to the server's `message`, clamped to one line; a `429` with no
usable code falls back to the rate-limit sentence, and any `5xx` to the
"having trouble" one. A client from another build should do the same.

### CORS, and what actually guards the write

`GET` is open to anyone: only the origins in `ALLOWED_ORIGINS` get an
`Access-Control-Allow-Origin` header, so a page from anywhere else can't read
the answer. `OPTIONS` returns `204` with the preflight headers, and there is no
wildcard.

CORS is **not** what protects `POST`, and it never could be: those headers
decide whether a browser hands the response to a page, not whether this Worker
runs. A form-style `text/plain` post from any page on the web is a "simple"
request the browser sends without a preflight. So the write endpoint refuses,
before it does anything else:

- a request with no `Origin`, or an `Origin` that is not in `ALLOWED_ORIGINS`
  → `403 forbidden`;
- a `Content-Type` that isn't `application/json` → `415 invalid_body`, which
  also means any cross-origin POST must survive a preflight to reach the
  handler at all.

Both are a **browser** CSRF guard and nothing more: `curl`, or any non-browser
client, can set whatever `Origin` it likes. What bounds abuse is the per-address
attempt cap, the body and depth limits, and the fact that the score comes from
the re-simulation rather than from the request.

### Rate limits

Two counters per (board, address), both enforced by the write itself — a
conditional `UPDATE … WHERE count < N` whose `changes` count is the verdict, so
a burst of simultaneous requests cannot all read an under-cap value and all go
through:

| Counter              | Cap | Charged                          | Bounds            |
| -------------------- | --- | -------------------------------- | ----------------- |
| `requests_per_ip`    | 12  | before the replay is verified    | CPU spend         |
| `submissions_per_ip` | 3   | by the insert, in the same batch | rows on the board |

The attempt counter is the one that matters for abuse: verification is the
expensive step, and counting only ACCEPTED posts left every rejected submission
free. A malformed body, an unlisted origin or a bad name is refused before the
charge, so a typo doesn't cost a player an attempt.

## What is stored, and what is not

Stored per submission: the display name and the verified `won`/`drew`/`turns`/
`attacks`/`captures`, plus a salted SHA-256 of `${IP_SALT}:${date}:${address}`
(to cap submissions — the date is in the preimage, so the digest is a per-day
pseudonym and not a handle that follows anyone from board to board), and a
SHA-256 of the replay's identity: the date, the board fields the verifier
compares, and the action list. Not the raw body — that would have keyed the
duplicate index on `metadata`'s wall-clock timestamp and on the client's key
order, so an honest retry looked like a new game. It exists to reject the same
submitter posting the same game twice, and is scoped per address because two
players _can_ produce identical replays on a fixed seed.

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

6. **Point the game at it** — only once the CPU ceiling is raised (see [Cost and
   limits](#cost-and-limits); the free plan's 10 ms budget cuts off a long
   replay mid-verification). Set the GitHub repository variable
   `DAILY_LEADERBOARD_URL` to that URL (no trailing slash). The Pages build
   passes it to Vite as `VITE_DAILY_LEADERBOARD_URL`; with the variable unset,
   the client treats the leaderboard as disabled and the UI hides it, so the
   game keeps working with local results only.

   ```sh
   gh variable set DAILY_LEADERBOARD_URL --body "https://dicewars-daily-leaderboard.<subdomain>.workers.dev"
   ```

### Deploy order: the Worker replays the game, so it holds a copy of the rules

The Worker bundles the engine. If a deploy changes how a game plays or how it is
scored while the Worker is still running the old code, every honest post fails
`unverifiable` — the board fields still match, so it does not even come back as
`wrong_board`.

So a change under any of:

- `src/engine/`
- `src/ai/ai_default.js`
- `src/game/matchJournal.js`
- `src/game/verifyDailyReplay.js`
- `src/game/dailyChallenge.js`
- `src/arena/replayFormat.js`

must be shipped with `npm run deploy` of this Worker **before or with** the Pages
deploy of the game — or, if the boards themselves are meant to change, with a
`DAILY_VERSION` bump so old and new are different challenges rather than the same
one scored two ways.

### Local development

```sh
npm run dev              # wrangler dev on http://localhost:8787
npm run migrate:local    # apply the schema to the local D1
```

`wrangler dev` has no `CF-Connecting-IP`, so every local request shares one
`unknown` bucket and the caps are reached fast. To get per-address buckets
locally, set `TRUST_FORWARDED_FOR = "1"` and the Worker will read
`X-Forwarded-For` instead — never set it in production, where the header is
caller-supplied and would hand anyone a fresh bucket per request. Put both it
and `IP_SALT` in a `.dev.vars` file (git-ignored, and listed in the repo's root
`.gitignore`):

```sh
IP_SALT="local-dev-salt"
TRUST_FORWARDED_FOR="1"
```

### Cost and limits

Verifying one replay re-simulates a whole game. Measured on an M-series Mac —
Cloudflare's hardware is slower, so read these as a floor:

| Replay                  | CPU                        |
| ----------------------- | -------------------------- |
| typical daily game      | 1.6 ms median              |
| 840 actions / 215 turns | 6.5 ms median, 10.4 ms p90 |

The long tail does **not** fit the free plan's 10 ms per-request budget, and it
is a legitimate result — an eliminated player who spectates on to the turn-cap
draw — not an attack. On the free plan those submissions get cut off
mid-verification and the player who earned them sees an error.

So: **move the Worker to Workers Paid and uncomment the `[limits] cpu_ms` block
in `wrangler.toml` before setting the `DAILY_LEADERBOARD_URL` repository
variable.** Until that variable is set the client treats the leaderboard as
disabled and the game keeps working on local results, which is the honest state
to ship in the meantime.

Reads are two indexed queries — the top wins and the totals, issued together —
and cost nothing to speak of.

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
