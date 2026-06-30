---
name: ship-ppo-weights
description: Export a PPO checkpoint, gate it vs ai_lookahead, and if it BEATS swap the live in-browser ppoPolicyWeights.js + regen the parity fixture, verify, and update ml-bot docs
disable-model-invocation: true
---

Ship a trained PPO checkpoint as the live in-browser `ai_ppo` weights — the exact manual flow PR #78 followed. Judge on win%, never ELO. **Do not swap the weights unless the gate returns BEAT.**

The export step writes BOTH the weights module (`src/ai/ppoPolicyWeights.js`) AND the parity fixture (`tests/fixtures/bc/ppoForwardCases.json`) from the **same loaded model** in one command — that co-generation is what ties weights ↔ fixture (there is no separate sha256/hash step in the tooling; the only weights↔fixture binding is that the fixture's Python-reference logits+argmax are produced by the same model the weights came from). The gate and the parity tests then cross-check the pure-JS forward (`bcForward.js`) against that fixture within `PARITY_TOL = 1e-3` and exact argmax.

## Procedure

1. **Export the checkpoint to JS weights + parity fixture** (needs a torch box — `shodan`; this Mac has no torch):

   ```bash
   npm run ppo:export
   # = cd ml && python -m dicewars_bc.export_weights \
   #     --ckpt checkpoints/ppo-tracer.pt \
   #     --out ../src/ai/ppoPolicyWeights.js \
   #     --fixture ../tests/fixtures/bc/ppoForwardCases.json
   ```

   - The `npm run ppo:export` script hardcodes `--ckpt checkpoints/ppo-tracer.pt`. To export a different checkpoint, run the `python -m dicewars_bc.export_weights …` command directly with your real `--ckpt path/to.pt` (keep the same `--out` / `--fixture`).
   - Export fails loud if the checkpoint's `encoding_version` ≠ the trainer's `EXPECTED_ENCODING_VERSION` (stale-encoding guard) — re-export from a checkpoint matching the current JS encoding if it does.
   - This overwrites both `src/ai/ppoPolicyWeights.js` and `tests/fixtures/bc/ppoForwardCases.json` in the working tree. Don't hand-edit either.
   - **Cross-box transfer**: in practice the export runs on `shodan` where the checkpoint lives. Copy **both** generated files back into this repo before gating (the weights module and the fixture), and optionally `shasum -a 256` each end to confirm the transfer is byte-identical (PR #78 did this integrity check by hand — it is not part of the tooling). Everything from step 2 on runs locally.

2. **Gate the candidate head-to-head vs `ai_lookahead`** (the bar, pinned `@596f781`):

   ```bash
   npm run ppo:gate                      # default: 20 runs × 150 games, src/ai/ppoPolicyWeights.js + ppoForwardCases.json
   # tighten the CI on a marginal edge with more runs/games:
   npm run ppo:gate -- --runs 30 --games 200
   ```

   The gate first runs the **parity pre-flight** (`loadExportedPolicy`): it reproduces the Python reference logits + argmax within `1e-3`, and aborts if the export is numerically broken — so a passing gate already proves weights↔fixture parity. It then runs a seat-fair, seat-counterbalanced FFA sweep (BC clone dropped, candidate in its place), measuring the candidate and Lookahead in the **same** games and printing each side's win% (95% CI) plus the **paired Δ win% (cand − bar)** with a `[lo, hi]` CI and a BEAT/TIE/BEHIND verdict.

3. **Read the verdict — this is the branch:**

   - **BEAT** = the whole paired Δwin% 95% CI is strictly above 0 (`lo > 0`). Only BEAT passes the gate. Proceed to step 4.
   - **TIE** (CI spans 0) or **BEHIND** (CI below 0) → **STOP. Do not ship.** Revert the working-tree changes to `ppoPolicyWeights.js` + `ppoForwardCases.json` (`git checkout -- src/ai/ppoPolicyWeights.js tests/fixtures/bc/ppoForwardCases.json`), and record the no-go (and Δ) in `docs/ml-bot/RESULTS.md` / `LOG.md`. A small true edge may just need more `--runs` to clear the CI — re-gate with a larger budget before concluding.

4. **The swap is already done.** Step 1's export already wrote the new `src/ai/ppoPolicyWeights.js` and the matching `ppoForwardCases.json` in place — there is no separate copy/swap step. The `ai_ppo` bot is **decoupled from its weights**: it is wired in `src/arena/builtInBots.js` + `src/ai/aiConfig.js` and just imports `ppoPolicyWeights.js`, so swapping the weights file needs **no code change** (in-game difficulty-5 + the daily tournament/leaderboard pick up the new net automatically).

5. **Verify the parity fixture and forward pass in the suite** (these consume the regenerated fixture):

   ```bash
   npx vitest run tests/ai/ppoForward.test.js tests/ml/ppo-action-parity.test.js
   ```

   `ppoForward.test.js` asserts the JS forward reproduces the reference logits+argmax (`parity < 1e-3`, `encodingVersion === 2`); `ppo-action-parity.test.js` pins the action-encoding bridge. Both must be green.

6. **Run the full suite once** (let the main agent do this — see CLAUDE.md; subagents should not each run `npm test`):

   ```bash
   npm test
   ```

7. **Update the ml-bot docs** (`docs/ml-bot/`) to reflect the ship:
   - `RESULTS.md` — add a Headline row: date, candidate, phase, field, seeds/games, candidate win% (95% CI), the verdict vs the bar, and the pinned `Lookahead @596f781`, with the exported params/parity and a commit/PR ref (match the existing table columns and tone).
   - `LOG.md` — add a session entry at the **top** (newest-first) using the file's template (Phase · Who · Did / Learned-decided / Dead ends / Next).
   - `README.md` — refresh the top **Status** banner + **Last updated** date if this changes the headline (a new BEAT / live weights swap).
   - `PLAN.md` — tick the corresponding step/task if this closes one.
   - If CI's `format:check` later flags any of these `.md` files, run `npx prettier --write <file>` (the pre-commit hook occasionally under-normalizes Markdown — see CLAUDE.md Gotchas).
