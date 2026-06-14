---
name: game-test
description: Run tests related to recently changed files, mapping source changes to the correct test suites
---

Run tests intelligently based on what was changed:

1. Check `git diff --name-only` for changed files
2. Map changed files to test suites:
   - Files in `src/ai/` → run `npx jest tests/ai/`
   - Files in `src/mechanics/` → run `npx jest tests/mechanics/`
   - Files in `src/models/` → run `npx jest tests/models/`
   - Files in `src/state/` → run `npx jest tests/state/`
   - Files in `src/ui/` → run `npm test` (no dedicated UI test suite exists yet)
   - For other `src/` files or if multiple areas changed → run `npm test`
3. If no changed files are detected, ask the user which tests to run
4. Always report coverage delta if tests pass by comparing with `npx jest --coverage` output
