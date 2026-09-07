# Daily Conquest

Daily Conquest is a small daily game of classic DiceWars: you and three Standard opponents on a small map. Choose **PLAY DAILY** below the ordinary setup. Everyone running the same game version gets the same starting board, turn order and dice for that UTC date. A new board arrives at **00:00 UTC**.

## One scored attempt

Your **first completed attempt** on a date is the one that counts. A win, an elimination, or a turn-limit draw completes an attempt; quitting does not. Spectating after elimination and watching a replay change nothing.

After that, the same board stays open for **practice**. PRACTICE from the title and PRACTICE AGAIN from the result screen replay today's board as often as you like. Practice runs are counted but never change the scored result, and they cannot be posted to the leaderboard.

The scored attempt is remembered per browser. Clearing site data, a private window, or another device starts the day over. If two tabs play the same board at once, the first to finish is the scored one and the other is recorded as practice, whatever it was told at the start. The leaderboard's own guard against repeat posting is a small per-network daily cap, so a determined player can still practice elsewhere first. That tradeoff is deliberate: it keeps the game free of accounts.

## Same dice, on purpose

The board's seed fixes the map, the turn order and the whole sequence of dice. Two players who make the same moves see the same rolls, and the opponents, who are deterministic, respond the same way. Nobody tops the leaderboard because of better dice. Different moves lead to different rolls from that point on, so repeating a board does not guarantee the same battles after different decisions.

## Score, streak and sharing

The score is **your turns**: a turn counts when you first attack or end it, and a victory during an attack includes that final turn. An elimination before your first action counts as zero turns.

Your **streak** is the number of consecutive UTC dates with a scored attempt, ending today or, if you have not played yet today, yesterday. Wins are not required to keep a streak. Only the newest 30 dates are kept on this browser, so a streak reads at most 30 days.

**COPY RESULT** on the result screen produces a short, spoiler-free text for sharing:

```
Dice Wars Daily · Sep 7, 2026
Won in 9 turns · 36/37 attacks won
Streak: 3 days
https://ivanlay.com/dicewarsjs/
```

**SHARE** appears on devices that offer a native share sheet.

## Leaderboard

Each day's leaderboard ranks scored **wins** by fewest turns; ties go to the earlier post. Losses and draws can be posted too and count toward the day's totals. Post from the result screen with a display name (1–16 characters, no account). The title screen shows the top three and the day's totals.

The server never trusts a claimed score. A post is the game's replay, and the server rebuilds the game from the daily seed, replays your moves through the same engine, runs the same opponents itself, and derives the result. A replay with an illegal move, altered opponent moves, a different board, or an unfinished game is rejected. Posting is open for the current and previous UTC date.

Stored per post: display name, result, turn count, attack counts, and a salted hash of the network address used only for the daily caps (a few posts and a bounded number of requests per network per day). Replays are not kept on the server or in the browser. There is no account, no email, and no cross-device sync of personal records.

### Anti-cheat, honestly

The verifier makes a posted score truthful: it is the result of a real game against the real opponents on the real board. It does not prove the game was the player's first. The date and the seed are both public, so a player can practice a board offline, in another browser, or with a forward-set clock before posting, and the streak in the share text is a local number nobody checks. The leaderboard is for bragging rights among friends, not for prizes.

## Supply and campaign reports

Both daily and ordinary human games show your position during play:

- **Land:** all territories you own.
- **Reinforcements:** the dice you earn when you end your turn, one per territory in your largest connected group. Placement and stockpile caps follow the normal rules.
- **Stockpile:** reinforcement dice held in reserve.

The end-of-match report shows your turns, attacks won, most land held, and your best reinforcement total. Its chart samples your land at the start, after each of your turns, and at the finish. Peaks count every attack, so a brief mid-turn high can exceed the chart's samples. The chart has a text equivalent for screen readers.

**TRY AGAIN** after an ordinary match restores the original setup, starting board, dice and turn order and goes straight into play. If you used NEW MAP, it retries the board you accepted.

## Implementation contract

- `src/game/dailyChallenge.js` owns the UTC date, the versioned identity (`daily-v1-YYYY-MM-DD`) and the deterministic seed. Version 1 is four seats on Small, the original `ai_default` in all three opponent seats, human seat 0, no handicap. A pinned checksum test guards the real initial engine state; if a future engine, map or AI change alters daily reproducibility, advance `DAILY_VERSION`, which also moves the storage namespace and the id prefix, rather than mixing incompatible results.
- `src/store/dailyRecords.js` keeps the scored result, the practice count and the leaderboard post per date under `dicewars_daily_v<version>`, newest 30 dates retained. A real storage failure reports `available: false` and play continues; a corrupt stored value is replaced on the next save.
- `src/game/matchJournal.js` reads resolved state transitions without consuming RNG or changing engine state. The controller records both human and AI actions and freezes the journal at the human's result. Statistics never block the game loop.
- `src/game/dailyShare.js` formats the share text. `src/game/dailyLeaderboard.js` is the HTTP client; it is disabled unless the build sets `VITE_DAILY_LEADERBOARD_URL` (the Pages deploy reads the repository variable `DAILY_LEADERBOARD_URL`).
- `src/game/verifyDailyReplay.js` is the pure verifier shared with the server in `server/daily-leaderboard/` (a Cloudflare Worker with D1). See that folder's README for deployment, including the measured CPU cost per verification: long games exceed the free plan's budget, so a paid plan with `[limits] cpu_ms` enabled is a prerequisite for setting `DAILY_LEADERBOARD_URL`.
- Daily identity lives outside the ordinary `store.config`, so the player's own setup survives the daily detour. The controller resolves the daily setup and refuses a reroll; the UI is not the only guard.
- No engine rules, AI strategies, handicap rules, arena/tournament fields, replay schemas, or ML encoding/weights are changed by this feature.
