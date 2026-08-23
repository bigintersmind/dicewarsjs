# Continuous integration (CI) setup

This document describes the CI setup for the DiceWarsJS project, which runs on GitHub Actions.

## Overview

GitHub Actions runs the tests, the linter, and the build on every change, so problems surface early instead of piling up.

## Workflow configuration

The CI workflow is defined in `.github/workflows/ci.yml` and runs these steps:

1. Set up Node.js, with multiple versions (16.x, 18.x)
2. Install dependencies with `npm ci`
3. Check formatting with Prettier
4. Run ESLint
5. Create a production build
6. Run unit tests with Jest
7. Run the benchmark tests

## When CI runs

The workflow is triggered on:

- Every push to the `master` branch
- Every pull request targeting the `master` branch

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

# Run tests
npm run test

# Run build
npm run build

# Run benchmarks
npm run test:benchmark
```

## Troubleshooting CI failures

If a CI build fails, check the logs in the GitHub Actions tab. Common fixes:

1. Lint errors: run `npm run lint:fix` locally
2. Formatting issues: run `npm run format` locally
3. Failed tests: debug with `npm run test` locally
4. Build errors: reproduce with `npm run build` locally

## Future improvements

Planned improvements to the CI pipeline:

- Adding code coverage reporting
- Performance regression monitoring
- Bundle size monitoring
- Deployment automation
- Release packaging
