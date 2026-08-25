# Lint and style configuration

## Overview

This document explains how lint findings are graded in DiceWarsJS: what fails a build, what is merely a warning, and how many warnings the project tolerates. For the config in full, plus Prettier and the pre-commit hook, see [Code style guidelines](./CODE_STYLE.md).

## ESLint configuration

The config is `.eslintrc.cjs`, in the eslintrc format on ESLint 8.

- Extends `plugin:vitest/recommended` and `plugin:prettier/recommended`. No shared base ruleset, so nothing is on unless the config names it.
- Plugins: `vitest`, `prettier`, and `react` with only `react/jsx-uses-vars` enabled for Preact's JSX.
- ECMAScript 2022, ES modules, JSX enabled. Browser, Node, and es2021 globals.
- A `tests/**` override supplies the Vitest globals through `vitest/env`.

## Warnings vs. errors

**Errors** must be fixed for CI to pass:

- Syntax errors, and any reference to an undeclared variable (`no-undef` is on explicitly, since the config does not extend `eslint:recommended`)
- Formatting that disagrees with Prettier, reported as `prettier/prettier`
- The modern-JavaScript rules: `prefer-const`, `no-var`, `object-shorthand`, `prefer-template`, `prefer-arrow-callback`, `arrow-body-style`, `arrow-parens`, `prefer-rest-params`, `prefer-spread`, `no-useless-constructor`, `no-useless-rename`, `no-duplicate-imports`, `template-curly-spacing`
- `spaced-comment`, and `react/jsx-uses-vars`
- Whatever `plugin:vitest/recommended` flags in test files, less `vitest/valid-title` and `vitest/expect-expect`, which are switched off

Most of the rule-based errors are auto-fixable, so `npm run lint:fix` clears them. `no-undef` is not: only you know what the identifier was supposed to be.

**Warnings** are allowed but discouraged. There are three:

- `no-unused-vars`
- `no-shadow`
- `no-prototype-builtins`

Everything else the config touches is either an error or off. The list of rules deliberately turned off for game code is in [Code style guidelines](./CODE_STYLE.md#eslint-configuration).

## The warning cap

`npm run lint` runs `eslint . --ext .js,.jsx,.mjs --max-warnings=100`, so warnings can accumulate up to 100 and then start failing the build. The same cap applies to the staged files in the pre-commit hook. `npm run lint:fix` carries no cap, since its job is to fix rather than to judge.

## CI process

The `CI` workflow checks formatting with `npm run format:check`, then lints with `npm run lint`, before it builds and tests. Both must pass. See [CI setup](./CI_CD.md) for the full pipeline.

The pre-commit hook runs the same two tools, scoped to staged files, and fixes what it can in place.

## Recommendations

When working on the project:

1. Use `npm run lint:fix` to fix most issues automatically
2. Pay attention to actual errors, not just warnings
3. Clean up warning-producing code when you touch it
4. Run `npm run format` to apply Prettier style rules

## Future improvements

Over time, aim to:

1. Reduce the number of warnings
2. Address common patterns like unused variables
3. Lower the warning cap as the count comes down
