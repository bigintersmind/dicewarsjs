# Daily Conquest experiment

Baseline: `f8b87d4` on `origin/master`. Experiment: `feat/field-notes`.

The idea is to give the human game a reason to return tomorrow and make its central strategic rule more visible: connected land funds the next turn. The experiment combines a daily board, a supply readout, a campaign report and a same-board retry. Ordinary setup and the original rules remain available.

## Comparison playtest

1. Play an ordinary Small/Standard game in each version. Notice whether the supply display helps you understand reinforcement and whether it competes with the board.
2. Play Daily Conquest in the experiment. After the result, use TRY AGAIN and change your opening. Notice whether the fixed board makes another attempt appealing.
3. Review the campaign chart. Does the report match your memory of the game? Are the turn count and income understandable?
4. Try a phone viewport, a landscape phone, and the light theme. The title and result can scroll on short screens; controls should remain reachable.

Useful questions: Which version would you keep playing? Did the daily board add a reason to return? Which new information did you actually use? Did any panel distract from the map?

## Browser evidence

Screenshots below come from local Chrome with the real PixiJS renderer. The complete daily match was driven through territory-button keyboard input and END TURN, with reduced motion and fast animation enabled. It ended in a loss after 15 human turns, with 36 of 37 attacks won. The result saved one completed attempt; TRY AGAIN returned to the daily preview.

- [Baseline title](daily-conquest/baseline-title.png)
- [Daily title](daily-conquest/daily-title.png)
- [Supply during play](daily-conquest/supply.png)
- [Campaign result](daily-conquest/campaign-result.png)
- [Phone title](daily-conquest/phone-title.png)
- [Phone result](daily-conquest/phone-result.png)
- [Landscape, light theme and alternate player palette](daily-conquest/landscape-light.png)

The browser pass also covered daily preview, retry, returning to setup, and both theme/palette combinations. Automated controller tests cover wins, early elimination, spectating after elimination, draws, preserved Custom setup, and retries across UTC midnight. Human enjoyment and difficulty remain for the comparison playtest; one automated policy's result is not evidence of how a novice will fare.

## Validation

- `npm test`: 147 suites, 2,609 passing tests, 1 existing skip.
- `npm run test:coverage`: the same suites pass; 93.12% statement coverage, all configured thresholds met. The daily recipe and journal modules have 100% coverage.
- Formatting, lint, production build and the separate benchmark command pass.
- Production preview at `/dicewarsjs/` loads and starts the daily board with no JavaScript errors, failed requests or persona-weight downloads.

Two small workflow repairs accompany the feature. Vite preview now uses the same `/dicewarsjs/` base as the production build, fixing missing assets during local preview. Prettier ignores `.superpowers/`, whose local working notes are excluded from Git but were still breaking the formatting command. The ML socket smoke tests require local socket access; they pass outside the sandbox, including in both final full-suite runs.
