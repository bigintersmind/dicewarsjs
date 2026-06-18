# Continuous Integration (CI) Setup

This document describes the CI setup for the DiceWarsJS project using GitHub Actions.

## Overview

The project uses GitHub Actions to automate testing, linting, and build processes. This ensures that code quality is maintained and that any issues are detected early in the development process.

## Workflow Configuration

The CI workflow is defined in `.github/workflows/ci.yml` and includes the following steps:

1. **Setup Environment**: Sets up the Node.js environment with multiple versions (16.x, 18.x)
2. **Install Dependencies**: Installs project dependencies using `npm ci`
3. **Code Style Check**: Verifies that code follows formatting rules using Prettier
4. **Linting**: Runs ESLint to check for code quality issues
5. **Build**: Creates a production build of the application
6. **Testing**: Runs unit tests with Jest
7. **Benchmarks**: Executes benchmark tests to ensure performance

## When CI Runs

The CI workflow is triggered on:

- Every push to the `master` branch
- Every pull request targeting the `master` branch

## CI Status

You can check the status of CI runs in the GitHub Actions tab of the repository. Each commit and pull request will display its CI status, making it easy to identify if there are any issues.

## Local Validation

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

## Troubleshooting CI Failures

If a CI build fails, check the logs in the GitHub Actions interface to identify the specific issue. Common problems include:

1. **Linting Errors**: Fix by running `npm run lint:fix` locally
2. **Formatting Issues**: Fix by running `npm run format` locally
3. **Failed Tests**: Debug by running `npm run test` locally
4. **Build Errors**: Check for compilation issues by running `npm run build` locally

## Future Improvements

Planned improvements to the CI pipeline include:

- Adding code coverage reporting
- Performance regression monitoring
- Bundle size monitoring
- Deployment automation
- Release packaging
