# Continuous integration (CI) setup

This document describes the CI setup for the DiceWarsJS project, which runs on GitHub Actions.

## Overview

GitHub Actions runs the tests, the linter, and the build on every change, so problems surface early instead of piling up.

## Workflow configuration

The main workflow is `.github/workflows/ci.yml`. It has one job, `build-and-test`, running on `ubuntu-latest` against a Node version matrix that currently holds a single entry, 22.x. The steps:

1. Check out the repo and set up Node.js with the npm cache
2. Install dependencies with `npm ci`
3. Check formatting with `npm run format:check`
4. Run ESLint with `npm run lint`
5. Create a production build with `npm run build`
6. Run the test suite with coverage via `npm run test:coverage`
7. Run the benchmark tests with `npm run test:benchmark`
8. Run the PPO env-server smoke checks
9. Upload the `coverage` directory as a build artifact, kept for 7 days

Step 6 enforces the coverage thresholds declared in `vite.config.js`, so a drop below the floor fails the build rather than just reporting a lower number.

Step 8 forks the Node env-server and talks to it over a live socket (`ppo:env-smoke`, `ppo:disconnect-smoke`, `ppo:booking-smoke`, `ppo:shaped-smoke`). These are pure Node with no Python, which is why they live here and not in the ML workflow.

## When CI runs

The workflow is triggered on:

- Every push to the `master` branch, except pushes that only touch `public/data/**`. Those are the daily tournament's generated results, and re-running the whole suite for a data-only commit buys nothing.
- Every pull request targeting the `master` branch

## Other workflows

- `deploy.yml` builds the site and deploys `dist/` to GitHub Pages on every push to `master`, and on manual dispatch. Deploys are serialized, and a run still in flight is cancelled when a newer one starts.
- `tournament.yml` runs the online tournament daily at 06:00 UTC, on manual dispatch, and on pushes that touch `community-bots/`, `src/arena/`, or `src/engine/`. It commits the refreshed results under `public/data/`, which in turn triggers a deploy so the live leaderboard updates.
- `validate-bots.yml` runs `validate-community-bots` on pull requests that touch `community-bots/`, and uploads the output as an artifact. It executes PR-supplied code, so it holds no secrets and only a read-only token.
- `validate-bots-comment.yml` picks up that artifact on `workflow_run` and posts the result as a PR comment. It holds the write token but never runs PR code. The comment is informational and is not a merge gate.
- `ml-ci.yml` is the Python CI for the `ml/` trainer package: ruff plus pytest on Python 3.11, scoped to changes under `ml/` or to the two files that carry the JS side of the encoding contract.
- `claude.yml` runs Claude Code on issues and comments that mention `@claude`.

## CI status

Check run status in the repository's GitHub Actions tab. Each commit and pull request shows its CI status.

## Local validation

Before pushing changes, you can run the same checks locally:

```bash
# Install dependencies
npm install

# Check code formatting
npm run format:check

# Run linting
npm run lint

# Run build
npm run build

# Run tests with coverage, the way CI does
npm run test:coverage

# Run benchmarks
npm run test:benchmark
```

## Troubleshooting CI failures

If a CI build fails, check the logs in the GitHub Actions tab. Common fixes:

1. Lint errors: run `npm run lint:fix` locally
2. Formatting issues: run `npm run format` locally
3. Failed tests: debug with `npm test` locally
4. Coverage below the floor: `npm run test:coverage` names the file and metric that fell short
5. Build errors: reproduce with `npm run build` locally

## Future improvements

Not done yet:

- Performance regression monitoring. The benchmarks run in CI, but nothing compares the numbers against a baseline or fails on a regression.
- Bundle size monitoring
- Release packaging
