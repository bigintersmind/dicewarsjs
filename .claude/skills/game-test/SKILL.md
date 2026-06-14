---
name: game-test
description: Run tests related to recently changed files, mapping source changes to the correct test suites
---

Run tests intelligently based on what was changed:

1. Check `git diff --name-only` for changed files
2. Map changed files to test suites:
   - Files in `src/ai/` → run `npx vitest run tests/ai/`
   - Files in `src/mechanics/` → run `npx vitest run tests/mechanics/`
   - Files in `src/models/` → run `npx vitest run tests/models/`
   - Files in `src/state/` → run `npx vitest run tests/state/`
   - Files in `src/ui/` → run `npm test` (no dedicated UI test suite exists yet)
   - For other `src/` files or if multiple areas changed → run `npm test`
3. If no changed files are detected, ask the user which tests to run
4. Always report coverage delta if tests pass by comparing with `npm run test:coverage` output
