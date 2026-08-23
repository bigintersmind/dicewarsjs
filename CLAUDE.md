# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important Project Status Update:** The project has completed its modernization (see `docs/MODERNIZATION_ROADMAP.md`). The legacy CreateJS code and the deprecated legacy↔modern bridge have been removed — the repo is now **modern-only** (Vite + PixiJS + Preact, running on a pure `src/engine/`). Build new functionality per the roadmap.

## Build and Development Commands

The project uses **Vite** for builds and **Vitest** for testing (migrated from Webpack/Jest in Phase 1).

```bash
# Install dependencies
npm install

# Start Vite development server (port 3000)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run all tests (Vitest)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run benchmarks
npm run benchmark

# Check for linting issues
npm run lint

# Fix linting issues
npm run lint:fix

# Format code with Prettier
npm run format

# Check formatting without writing
npm run format:check

# Run Vitest benchmark tests
npm run test:benchmark

# Run bot arena (CLI) — single deterministic ELO ranking
npm run arena

# Multi-seed arena sweep — mean win%/ELO with 95% confidence intervals
npm run arena:sweep

# Scaffold a new bot from a template
npm run new-bot

# Validate a bot file (syntax, compilation, runtime)
npm run validate-bot

# Benchmark a single bot (timing, win rate, ELO, placement)
npm run benchmark-bot

# Validate all community-bots/registry.json entries
npm run validate-community-bots

# Run full online tournament (built-in + community bots), persist ELO/leaderboard
npm run tournament
```

## Code Quality Requirements

Before completing any task, always ensure:

1. **Tests Pass**: Run `npm test` to verify all tests pass
2. **Linting**: Run `npm run lint` to check for code quality issues
3. **Coverage**: Maintain test coverage above 60% globally, 70% for models, 50%+ statements for mechanics (run `npm run test:coverage`; see `vite.config.js` for exact per-directory thresholds)
4. **Build Verification**: Run `npm run build` to ensure the project builds successfully

When test failures occur:

- First run tests to see what's failing
- Fix any broken tests before making other changes
- Add new tests when implementing features

## Project Architecture

DiceWarsJS is a turn-based strategy game where players compete to conquer territories on a hexagonal grid using dice for attack and defense. The project is being modernized per `docs/MODERNIZATION_ROADMAP.md`.

### Build Stack

- **Build**: Vite (replaced Webpack)
- **Tests**: Vitest (replaced Jest)
- **Rendering**: PixiJS v8 (replaced CreateJS)
- **UI**: Preact (replaced legacy DOM manipulation)
- **Config**: `vite.config.js` contains both build and test configuration

### Architecture

1. **Modern ES6 Modules**: All active code in the `src/` directory uses ES6 imports/exports with relative paths. The entry point is `src/main.jsx` (loaded by the root `index.html`).

2. **Game Engine**: `src/engine/` contains the pure game engine — no DOM, no rendering. Includes StateManager, BattleResolver, MapGenerator, TurnManager, HexGrid, AIAdapter, and GameRunner.

3. **Rendering & UI**: `src/renderer/` (PixiJS hex grid, dice, battle animation), `src/ui/` (Preact screens and HUD), `src/store/` (observable GameStore), `src/controller/` (GameController orchestrator), `src/audio/` (Web Audio SoundManager).

### Core Components

- **Game Engine** (src/engine/): Pure game logic — `createGame`, `applyAction`, `getValidMoves`, `runAI`. No DOM dependencies. Runs in both browser and Node.js.

- **AI System** (src/ai/): Contains different AI strategies:

  - ai_default: Balanced approach from the original game
  - ai_defensive: Prioritizes protecting vulnerable territories — **Picker-revived** (#167 difficulty modes) as Easy-lineup ingredients — still hidden on competitive surfaces (arena/tournament/leaderboard), though attract mode's decorative board (ATTRACT_BOT_IDS) still plays it behind the menus
  - ai_example: Basic implementation for educational purposes — **Picker-revived** (#167 difficulty modes) as Easy-lineup ingredients — still hidden on competitive surfaces (arena/tournament/leaderboard)
  - ai_adaptive: Adapts strategy based on game conditions
  - ai_strategist: Expected-value strategy using exact dice odds and connectivity economics (second-strongest hand-written bot — ai_lookahead's search outranks it by measured arena strength; authored by Claude Opus 4.8)
  - ai_lookahead: Standalone shallow-expectimax search over win/loss branches with board-value evaluation (authored by GPT-5.5)
  - ai_expectimax: Chance-node expectimax over the exact battle distribution — the "search-first" ML-bot baseline (docs/ml-bot/), at parity with ai_lookahead — **Hidden from players** (#164 roster trim) — dev/eval + CLI-by-name only
  - ai_bc: Behavioral-cloning net that imitates ai_lookahead, running in-browser via a pure-JS forward pass (bcForward.js) over exported weights (bcPolicyWeights.js); ml-bot Phase 2. **Hidden from players** ([D-27]) — flagged `hidden` in builtInBots.js, kept only as a dev/eval-harness bot (not in the in-game picker, the arena/tournament UI, or the gate field)
  - ai_ppo: Self-play PPO net (ml-bot Phase 3), aka `ppo-long` — trained by RL against a PFSP league, running in-browser via the same pure-JS forward pass (bcForward.js) over its own exported weights (ppoPolicyWeights.js, distinct from bcPolicyWeights.js). The first ML bot to beat ai_lookahead head-to-head (seat-fair win-rate Δ +27.7 pp). **Now hidden from players** ([D-27]) — "PPO" is an internal training name, so it's flagged `hidden` and kept as the dev-harness strength baseline (the `ppo:gate` bar), its v2 weights frozen for that role (Conqueror shipped these same weights until the [D-31] v3 ship)
  - ai_conqueror / ai_blitz / ai_survivor: the player-facing self-play **personas** (docs/ml-bot/PERSONAS.md, [D-27]) — the in-game + arena/tournament roster, each a makeBC({policy}) over its own weights. **Conqueror** = the encoding-v3 net (`ppo-v3-scratch`, [D-31]; conquerorPolicyWeights.js) — the strongest net the game ships (beat Survivor head-to-head Δ +5.5 pp, +33.9 pp over Lookahead); **Blitz** = a short-horizon (γ0.99) v3 fine-tune off the Conqueror base that closes games fast ([D-32]; BEAT its v2 predecessor +11.6 pp); **Survivor** = a placement-reward v2 fine-tune that outlasts the field (its v3 retrain was killed on three independent bars — [D-32], keep v2). Tagged `persona` in builtInBots.js, which keeps them OUT of the canonical ppo:gate reference field (challengers, not baselines). Since #164 the competitive-surface roster is 7 bots, strength-ordered (personas first), and the default battle lineup is the Standard difficulty preset — all ai_default, original-game parity (#167); the persona-led lineup is the Hard preset (src/ai/difficultyModes.js).
  - Difficulty modes (src/ai/difficultyModes.js): Easy/Standard/Hard preset lineups (Custom is UI-only), validated at import against the picker registry; note the two registries' hidden flags now differ by surface — aiConfig.hidden = picker, builtInBots.hidden = competitive surfaces (#167)
  - Luck handicap (#179): a per-seat dice handicap offered **only under the Custom difficulty preset** — the Easy/Standard/Hard presets always mean fair dice. The "Your luck" block at the bottom of the Custom panel writes `config.luck` (0/1/2, the `LUCK_LEVELS` ladder in `src/utils/config.js`) into the store; `resolveLuck(difficulty, luck)` is the rule that a rung only plays under `'custom'` (the title screen resets it on a preset click and seeds from the store only under Custom; the controller applies it again at the seam every caller goes through), and `luckToHandicap(luck, humanPlayerIndex)` turns it into the engine's `config.handicap = { playerId, level } | null` (the human seat rolls `level` extra dice and drops the `level` lowest, attacking and defending). Null everywhere else by construction: spectator/attract games have no human seat, and arena/tournament/leaderboard never pass it. Replay v2 whitelists it, so a handicapped game replays exactly; rejectMap must rebuild it or the setting vanishes on NEW MAP.

- **Bot Arena** (src/arena/): Headless bot-vs-bot tournament system — ELO ratings (elo.js), match/tournament runners, custom-bot compilation & validation, replay format. Powers `npm run arena`, the in-game Arena screen, and the CLI bot tooling. See docs/BOT_GUIDE.md for authoring a bot (a function: state → { from, to } | null).

- **GameController** (src/controller/GameController.js): Orchestrates the full game loop — title → mapPreview → playing → gameOver. Handles human input (two-phase click: select from, select to), AI turns with step-by-step animation, and turn advancement. Drives the engine for the real game; its sibling `TitleAttractMode.js` steps a private, decorative AI-vs-AI engine game behind the menu screens (`ATTRACT_SCREENS`: title + arena/tournament/leaderboard, whose chrome floats over the scrimmed live board — heuristic bots only, so no persona weight chunks load on the landing page).

- **GameStore** (src/store/GameStore.js): Observable pub/sub store shared by renderer, controller, and UI. Shallow-merge `setState`, subscriber notification with error isolation.

- **Renderer** (src/renderer/): PixiJS rendering layer — `GameRenderer` (top-level), `HexGridRenderer` (territory drawing with border tracing), `DiceRenderer` (isometric stacked dice), `BattleAnimation` (physics-based dice rolling).

- **UI** (src/ui/): Preact components — `App` (screen router), `TitleScreen`, `MapPreview`, `GameHUD`, `GameOverlay`, `GameOverScreen`. Uses `useGameStore` hook for reactive updates.

- **SoundManager** (src/audio/SoundManager.js): Web Audio API sound system replacing legacy CreateJS SoundJS. Lazy AudioContext creation, on-demand loading, volume control.

- **Map Generation** (src/engine/MapGenerator.js): Creates the hexagonal grid and territories.

- **Battle Resolution** (src/engine/BattleResolver.js): Handles attack resolution and dice distribution.

### ML / Self-Play Bot Pipeline (`ml/`, `docs/ml-bot/`)

An active, multi-session effort to produce an ML/self-play bot stronger than `ai_lookahead`. **Read `docs/ml-bot/README.md` first** (then PLAN/DECISIONS/LOG/RESULTS) — that folder is the source of truth for status and decisions, not this file. **When editing those docs:** DECISIONS.md + RESULTS.md append at the **end** (chronological); LOG.md is **newest-first** (prepend after the header); a persona kill-gate outcome is recorded as an `_(Outcome YYYY-MM-DD: …)_` annotation on its §10.8 PERSONAS bullet, mirroring the existing ones.

- **`ml/`**: in-repo Python/PyTorch trainers — `dicewars_bc` (behavioral cloning, Phase 2) and `dicewars_ppo` (PPO league, Phase 3). Has its own `pyproject.toml`, `requirements.txt`, and `ml/tests/` (pytest). Training runs on the GPU box `shodan`; a CPU box is fine for the dev loop.
- **Encoding contract** (lives in-repo so JS and trainer stay versioned together): `src/arena/encodeObservation.js` + `ENCODING_VERSION` + the corpus `manifest.json`. The JS encoder and the Python trainer that consumes it **must change in the same commit**.
- **Exported weights** loaded by in-browser bots: `src/ai/bcPolicyWeights.js` (BC), `src/ai/ppoPolicyWeights.js` (PPO), and one `<persona>PolicyWeights.js` per persona (conqueror/blitz/survivor). Distinct files — don't confuse them; each has a sibling `npm run <name>:export` script pinned to its source checkpoint. Since #51 these ship **packed**: a base64 little-endian Float32 blob decoded at import by `src/ai/unpackPolicyWeights.js` (~74% smaller than the old JSON-in-JS floats; the materialized `BC_POLICY` object is unchanged). `export_weights.py` emits packed by default, so a packed export **must** target `src/ai/` (where the sibling decoder lives) or it fails loud — PPO-league snapshots opt out with `--no-packed`/`packed=False` since they're written to a temp dir. To shrink an existing module without a checkpoint: `python -m dicewars_bc.export_weights --repack-js <file.js> --out <file.js>`.
- **Pipeline scripts**: `npm run selfplay` (JSONL corpus) → `npm run encode-corpus` (packed tensors) → train in `ml/` → `npm run ppo:export` (ckpt → weights). PPO RL loop driven by `npm run ppo:env-server` (+ `ppo:env-smoke`, `ppo:throughput-probe`, `ppo:league-probe`, `ppo:gate`). `npm run ppo:curve` (the [D-29] strength-curve scorer) walks a run's whole `eval/` stream and emits strength-vs-steps (`strength.jsonl` + regression/plateau analysis); designed to run on the mini via `--rsync-from`/`--watch` — see docs/ml-bot/STRENGTH_CURVE.md.
- **Behavioral-eval harness** (`docs/ml-bot/EVAL_HARNESS.md`): `npm run behavior:profile` profiles bots across a seat-fair seed sweep on behavioral axes (aggression, dice reserve, kills, turns-to-win, placement) as mean ± 95% CI, paired against a control — the "is the bot **different**, and how?" complement to `ppo:gate`'s "is it **stronger**?". `behavior:separation` pairs two identically-seeded profile reports; `behavior:preflight` runs launch pre-flight + negative controls; `behavior:turtle` is the stall/turtling probe. Used as a **kill-gate for persona retrains** (the §10.3 scavenge tripwires).
- **Long-run ops**: `scripts/shodan/RUNBOOK.md` is the operator guide for unattended PPO runs. **Launch ONLY via a Task-Scheduler-owned `wsl.exe`** — `nohup`/`&` over SSH is silently reaped when the WSL2 VM idle-shuts-down as the SSH session ends (symptom: trainer logs stop mid-startup at step 0, no error, `uptime` reset). Monitoring §6 — `ml/runs/<name>/launcher.log`, `state/latest.json` for the current step, `tb/progress-*.csv` for fps/metrics. **After the run, DELETE the schtasks task** (`schtasks /Delete /TN <name> /F` — not `Unregister-ScheduledTask -Confirm:$false`, whose `$false` mangles to a literal `\False` through PowerShell-over-SSH); an **AtStartup** trigger otherwise relaunches the _finished_ run on the next reboot.
- **Mid-run strength probes**: training runs export gate-ready weights every 1M steps to `ml/runs/<run>/eval/` (`eval-<step>.weights.js` + sibling `.fixture.json`). Gate any of them locally — `npm run ppo:gate -- --weights <f>.weights.js --fixture <f>.fixture.json --name <NonColliding>` (~8 min on a Mac, single-threaded, zero load on the training box).

### Important Design Patterns

1. **Immutable State**: The engine never mutates state in place — `applyAction(...)` returns a new state object (see `src/engine/StateManager.js`).

2. **Factory Functions**: Used throughout the codebase to create game objects.

### AI Implementation Notes

When working with AI strategies:

1. All AI functions must return 0 when they have no more moves to make (ends their turn).
2. AI functions perform attacks by setting `game.area_from` and `game.area_to` properties.
3. AI functions have access to the full game state through the game object parameter.
4. The AI system is designed to be extensible - new strategies can be added by creating a new file in src/ai/.
5. Randomness must come from `game.random()` (legacy interface) / `state.random()` (BotState) — a seeded per-decision stream. Never `Math.random`: it breaks same-seed match reproducibility (issue #151).

### Testing Approach

1. Unit tests for individual components (AI strategies, map generation, battle resolution).
2. Performance tests for comparing AI strategies.
3. Test utilities and mocks are located in the tests/mocks/ directory.
4. Benchmarks are in tests/benchmarks/.
5. Error handling should be tested thoroughly, including edge cases.

### Running tests safely (resource limits)

The full suite forks many workers; running several copies at once can exhaust RAM and freeze the machine. Two guardrails are in place: each run is capped at 50% of cores (`maxWorkers` in `vite.config.js`), and `npm test` / `npm run test:coverage` go through a machine-wide lock (`scripts/test-lock.sh`) so only one run executes at a time — concurrent callers queue rather than pile up.

**Subagents must not each run the full suite.** When work is delegated across multiple subagents, do not have each one call `npm test`. Instead:

- Prefer the `game-test` skill, or run only the relevant tests with `npx vitest run <path-or-pattern>` for the area you changed.
- Let the **main agent** run the full `npm test` once, at the end, to validate. The lock makes accidental overlap safe but it serializes (slow); avoiding redundant full runs is still the goal.

## Best Practices

1. **Code Style**: Follow existing code patterns and conventions
2. **Documentation**: Update relevant documentation when making significant changes
3. **Error Handling**: Validate inputs at boundaries and raise or return errors explicitly rather than failing silently
4. **Testing**: Write tests for new functionality and ensure existing tests pass
5. **Commit Messages**: Use conventional commit format (e.g., "feat:", "fix:", "test:", "docs:")

## Gotchas

- **Imports**: Source files use relative paths — the project configures no path aliases. (The old `@utils`/`@ai`/`@engine` Vite aliases were unused and have been removed.)
- **Husky pre-commit hook**: Runs `lint-staged` automatically — `eslint --fix` + `prettier --write` on staged `.js`/`.jsx`/`.mjs` files, and `prettier --write` on staged `.json`/`.md`/`.yml`/`.yaml` files. Note it formats Markdown too, but it has occasionally failed to fully normalize a `.md` file (e.g. a multi-line inline-code span), so if CI's `format:check` (`prettier --check .`) flags a doc, run `npx prettier --write <file>` yourself.
- **Line width applies to code, not comments**: `printWidth: 100` is owned by Prettier and there is **no ESLint `max-len`** rule (deliberately — see `.eslintrc.cjs`). Prettier auto-wraps long _code_ (function calls, objects, JSX) for free, but it never reflows comments or string contents. So a 140-char `//` comment passes `prettier --check` and lint clean. Don't hand-trim comments to hit 100 — it's wasted effort that nothing enforces; break a comment only when it genuinely aids readability.
- **Vitest globals**: Tests use `globals: true` in vitest config, so `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` are available without imports. Use `import { vi } from 'vitest'` only if needed for explicit typing.
- **Test environment is `node` by default**: To keep memory down, the suite runs under the lightweight Node environment, not jsdom. A test that touches `document`, `window`, `localStorage`, canvas, or renders a Preact component must declare `// @vitest-environment jsdom` as the first line of the file, or it will fail with `X is not defined`.
- **JS↔Python encoding contract**: `src/arena/encodeObservation.js` feeds the `ml/` trainers. Any change to feature columns/order must bump `ENCODING_VERSION` and land alongside the matching trainer change in one commit, or the trained net silently mismatches the live observation. Since v3 ([D-31]) the change must also be **append-only** (existing columns never move or renormalize): JS inference accepts any `SUPPORTED_ENCODING_VERSIONS` stamp by letting older, narrower nets ignore the appended tail columns — so shipped v2 weights keep working — while the Python trainer stays strict-current-version.
- **PPO obs-frame wire ≠ `ENCODING_VERSION`**: the binary frame HEADER (`scripts/lib/obs-frame.mjs` ↔ `dicewars_ppo/constants.py` `HEADER_STRUCT`) is a SEPARATE layout from the observation tensor. Reward-only signals belong in the header (the net never sees it) — e.g. the bite-G dense-reward variant `HEADER_STRUCT_SHAPED` ([D-28]) rides the header behind the opt-in `--reward-shaping` flag and deliberately does NOT bump `ENCODING_VERSION` (which would reject the `ppo-long`/BC weight guards). Header changes still need the JS emitter + Python parser in one commit; lean on the frame-length guard to fail a shaped/unshaped mismatch loud.
- **Worktrees get `node_modules` automatically**: a fresh `claude -w <name>` worktree has no `node_modules`, which breaks npx, lint, and the husky pre-commit hook. The `SessionStart` hook `.claude/hooks/link-node-modules.sh` symlinks the main checkout's `node_modules` into the worktree at session start, so there's no manual `ln -s` step. It's a silent no-op in the main checkout, when `node_modules` is already present, or when the main checkout has none. The link is shared: `npm install <pkg>` in a worktree writes into the main checkout's tree, and a plain `npm install` replaces the symlink with a real directory. (Lint-by-path inside a worktree has a separate, unrelated problem — see the eslint gotcha below.)
- **Worktree PRs break `gh pr merge --delete-branch` cleanup**: when a PR's branch is checked out in a `.claude/worktrees/` worktree, `gh pr merge --delete-branch` completes the API merge but errors on local cleanup (`fatal: 'master' is already used by worktree`). **The merge still lands** (`gh pr view <n> --json state` → `MERGED`); finish by hand: `git push origin --delete <branch>` → `git worktree remove <path>` → `git branch -D <branch>` → `git pull --prune` on master.
- **eslint "File ignored by default" inside `.claude/worktrees/`**: linting a file by path from a worktree checkout falsely reports it ignored — eslint v8 auto-ignores anything under the dot-prefixed `.claude/` ancestor. It lints fine in CI's normal checkout; verify locally with `npx eslint --no-ignore <file>` (the project lint is `eslint . --ext .js,.jsx,.mjs`, no `.eslintignore` — uses `ignorePatterns` in `.eslintrc.cjs`).

## Common Pitfalls to Avoid

1. Always run tests before suggesting code is complete
2. Surface errors explicitly instead of silently swallowing them
3. Keep AI functions pure and deterministic for testing

## Documentation Updates

### Key Documentation

- `docs/MODERNIZATION_ROADMAP.md` — architectural north star
- `docs/BOT_GUIDE.md` — how to write a bot
- `docs/ARCHITECTURE.md`, `docs/GAME_RULES.md`, `docs/TESTING.md`, `docs/CODE_STYLE.md` — system design, rules, testing approach, conventions

When making changes:

1. Update inline code comments for clarity
2. Update relevant docs in the docs/ directory
3. Update this CLAUDE.md file if workflow changes
4. Keep README.md synchronized with new features
