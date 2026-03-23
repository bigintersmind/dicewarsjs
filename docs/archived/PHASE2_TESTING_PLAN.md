# Phase 2 Testing Suite Enhancements

This document details the plans for strengthening the DiceWarsJS test suite during **Phase 2: Infrastructure and Environment Setup** of the ES6 migration.

## Goals

- Verify bridge modules and their interaction with legacy code
- Detect regressions early through automated tests
- Maintain code coverage as modules are migrated

## Planned Changes

### 1. Bridge Component Unit Tests

- Add tests that confirm each bridge exposes the correct ES6 classes and functions to the global scope
- Include failure scenarios to ensure fallback implementations work as expected
- Place these tests in `tests/bridge`

### 2. Bridge-to-Legacy Integration Tests

- Simulate loading legacy files alongside bridge modules using JSDOM
- Validate that legacy entry points can call modern APIs through the bridge
- Ensure the game boot sequence succeeds when bridges are loaded

### 3. Automated Regression Suite

- Introduce a `tests/regression` directory for regression scenarios
- Capture baseline game states and snapshots for common actions
- Run this suite with `npm run test:regression`
- Integrate it into the standard `npm test` command and CI workflow

### 4. Coverage Targets

- Keep the global thresholds defined in `jest.config.js`
- Track bridge module coverage separately; they are excluded from global metrics but must have tests for critical paths

### 5. CI Integration

- Update the GitHub Actions workflow to run unit, integration, and regression tests on every push and pull request
- Coverage reports are uploaded as CI artifacts

### 6. Documentation Updates

- Extend `docs/TESTING.md` with instructions for the new regression suite and bridge tests
- Document directory layout and common utilities for writing these tests

## Future Improvements

- Explore headless browser testing for full end-to-end scenarios
- Add performance regression checks for AI algorithms once Phase 3 begins
