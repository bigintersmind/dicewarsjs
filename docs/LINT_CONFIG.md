# Lint and style configuration

## Overview

This document explains the linting and style configuration for DiceWarsJS, including how warnings and errors are handled.

## ESLint configuration

The project uses ESLint with the following configuration:

- Base: `airbnb-base`
- Additional plugins: `import`, `jest`, `prettier`
- ECMAScript version: 2022 (to support private class fields with # syntax)

### Warnings vs. errors

**Errors** must be fixed for CI to pass:

- Syntax errors
- Import ordering issues
- Loops with await statements
- Empty block statements
- Functions declared in loops

**Warnings** are allowed but discouraged:

- Unused variables
- Shadowed variables
- Constant conditions in loops

The warning cap is 100, so warnings can't pile up indefinitely while work continues.

## CI process

The CI workflow:

1. Checks code style with Prettier
2. Runs ESLint with `--max-warnings=100`
3. Builds the project
4. Runs tests

Pre-commit hooks run the same lint and style checks locally.

## Recommendations

When working on the project:

1. Use `npm run lint:fix` to fix most issues automatically
2. Pay special attention to actual errors, not just warnings
3. Clean up warning-producing code when you touch it
4. Run `npm run format` to apply Prettier style rules

## Future improvements

Over time, aim to:

1. Reduce the number of warnings
2. Address common patterns like unused variables
3. Lower the warning threshold as code quality improves
