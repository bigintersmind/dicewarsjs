# Daily Conquest

Daily Conquest is a small daily game of classic DiceWars: you and three Standard opponents, on a small map, with fair dice. Choose **PLAY DAILY** below the ordinary setup. Everyone running the same game version gets the same starting board, dice and turn order for that UTC date. A new board arrives at **00:00 UTC**.

You can retry as often as you like. **TRY AGAIN** from the result screen returns to the same board, even if midnight passed during the match. **PLAY DAILY** from the title always opens today's board. Daily previews offer PLAY and BACK; the daily board cannot be rerolled. Your ordinary player count, difficulty, map size and Custom luck choices survive the daily detour.

## Personal results

The title remembers completed attempts and your fastest victory, measured in **your turns**, on this browser. A turn counts when you first attack or end it; a victory during an attack includes that final turn. An elimination before your first action counts as zero turns. Rounds in the supply display are the engine's full cycles through the turn order, a different measure.

An elimination or a turn-limit draw counts as a completed attempt. Quitting does not. Spectating after elimination and watching a replay cannot add attempts or change your campaign report. The best score is the fewest human turns in a **win**; a quick loss cannot replace a victory.

These are local personal records, with the most recent 30 daily dates retained. There is no online score submission or cross-device sync. When browser storage is unavailable, play still works and the title/result screen explains that personal results cannot be saved.

## Supply and campaign reports

Both daily and ordinary human games show:

- **Land:** all territories you own.
- **Income / turn:** your largest connected group, which supplies reinforcement dice when you end your turn. Placement and reserve caps follow the normal rules.
- **In reserve:** reinforcement dice held in stock.

The end-of-match report shows your turns, attacks won, most land held, and best connected-territory income. Its chart samples your land after each completed player-turn, plus the starting and final positions. Peaks count every attack, so a brief mid-turn high can exceed the chart's samples. The graph also has a text equivalent for screen readers.

**TRY AGAIN** is available after ordinary matches too. It restores the original setup, starting board, dice and turn order. If you used NEW MAP, it retries the board you accepted. Different actions can change the subsequent random sequence and the opponents' responses; repeating a board does not guarantee the same battle outcomes after different decisions.

## Implementation contract

- `src/game/dailyChallenge.js` owns the UTC date, versioned identity and deterministic seed. Version 1 is four seats on Small, with the original `ai_default` in all three opponent seats, human seat 0, and no handicap.
- `src/store/dailyRecords.js` validates stored records and bounds history under `dicewars_daily_v1`. A write failure does not prevent the game-over transition.
- `src/game/matchJournal.js` reads resolved state transitions without consuming RNG or changing engine state. `GameController` records both human and AI attacks and end turns, then freezes the journal at the human result.
- Daily identity is separate from the ordinary `store.config`. The controller resolves daily setup itself and prevents a daily reroll; the UI is not the only guard.
- The recipe's real initial engine state has a pinned checksum test. If a future engine/map/AI change affects daily reproducibility, intentionally advance the daily version and storage namespace rather than mixing incompatible results. The recipe does not promise identical boards across different game versions.
- No engine rules, AI strategies, handicap rules, arena/tournament fields, replay schemas, or ML encoding/weights are changed by this feature.
