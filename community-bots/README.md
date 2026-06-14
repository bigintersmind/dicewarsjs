# Community Bots

This is where community-submitted bots live. Every active bot here competes in
the **daily online tournament** ([`.github/workflows/tournament.yml`](../.github/workflows/tournament.yml)),
which ranks them by ELO against the built-in strategies and publishes the
results to the live [leaderboard](https://bigintersmind.github.io/dicewarsjs/).

The bots in [`bigintersmind/`](bigintersmind/) are official seed examples —
copy one as a starting point for your own.

## Submit your bot

1. **Fork** the repo and create a directory named after your GitHub username:
   `community-bots/<your-username>/`
2. **Add your bot** as a bare function body (same format as [`bots/`](../bots/) and
   the examples here) — it receives `state` and returns `{ from, to }` or `null`.
   See the [Bot Guide](../docs/BOT_GUIDE.md) for the full `state` reference.
3. **Add a `<bot>.meta.json`** next to it:
   ```json
   {
     "name": "My Bot",
     "author": "<your-username>",
     "description": "One line on your strategy"
   }
   ```
4. **Register it** in [`registry.json`](registry.json):
   ```json
   {
     "id": "<your-username>/my-bot",
     "name": "My Bot",
     "author": "<your-username>",
     "file": "<your-username>/my-bot.js",
     "description": "One line on your strategy",
     "submittedAt": "2026-01-01T00:00:00Z",
     "active": true
   }
   ```
5. **Validate locally**, then open a PR (CI re-runs the same checks):
   ```bash
   npm run validate-community-bots
   ```

## Notes

- **Keep bots deterministic** (avoid `Math.random`) so tournament results are
  reproducible from the daily seed.
- Bots run in a sandbox with only standard JavaScript built-ins — no
  `require`, `process`, `fetch`, file or network access. Each move has a time
  limit; exceeding it (or throwing) ends your turn.
- Set `"active": false` in your registry entry to keep a bot in the repo but
  out of the tournament.

## Seed bots

| Bot              | Strategy                                                      |
| ---------------- | ------------------------------------------------------------- |
| **Connector**    | Grows its largest connected group to maximize reinforcements. |
| **Blitz**        | Hyper-aggressive expander; takes even-odds fights for tempo.  |
| **Giant Slayer** | Focuses fire on the strongest player to stop runaways.        |
