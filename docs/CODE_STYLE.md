# Code style guidelines

DiceWarsJS uses ESLint and Prettier to enforce a consistent code style. This document covers the configuration and how to run the tools.

## Table of contents

- [Setup](#setup)
- [ESLint configuration](#eslint-configuration)
- [Prettier configuration](#prettier-configuration)
- [Using the tools](#using-the-tools)
- [Pre-commit hooks](#pre-commit-hooks)
- [Editor integration](#editor-integration)
- [Style rules overview](#style-rules-overview)

## Setup

ESLint and Prettier are installed with the rest of the dev dependencies:

```bash
# Install dependencies including ESLint and Prettier
npm install
```

## ESLint configuration

[ESLint](https://eslint.org/) checks code quality. The config is `.eslintrc.cjs`, in the eslintrc format on ESLint 8.

**What it extends.** `plugin:vitest/recommended` and `plugin:prettier/recommended`, and nothing else. There is no shared base such as `eslint:recommended` or `airbnb-base`, so every rule described below is one the project opted into by name.

**Plugins.**

- `vitest`: test-suite rules. A `tests/**` override turns on the plugin's `vitest/env`, so `describe`, `it`, `expect`, and `vi` resolve without a hand-maintained globals list.
- `prettier`: formatting differences are reported as `prettier/prettier` errors, and `eslint-config-prettier` switches off the stylistic rules that would fight Prettier.
- `react`: only `react/jsx-uses-vars` is enabled. JSX compiles to `h()` in this Preact project, so core `no-unused-vars` cannot see that `<TitleScreen />` uses the `TitleScreen` import, and every component import would be a false positive without it. No other React rule applies here.

**Parser and environments.** ECMAScript 2022, ES modules, JSX enabled. Browser, Node, and es2021 globals, plus `structuredClone`.

**Errors.**

- `no-undef`. On explicitly, because `eslint:recommended` is not extended and the rule would otherwise be off. It is the cheapest net for a typo'd or un-threaded identifier that lints clean and throws on the first run.
- The modern-JavaScript set: `prefer-const`, `no-var`, `object-shorthand`, `prefer-template`, `prefer-arrow-callback`, and the rest of that family (nine more, listed in the config).
- `spaced-comment`, which requires a space after `//` and `/*`. Auto-fixable.

**Warnings.** Three: `no-unused-vars`, `no-shadow`, `no-prototype-builtins`. They do not fail the build until the warning cap is reached. See [Lint and style configuration](./LINT_CONFIG.md).

**Relaxed for game code.** `no-console` is off, since the game logs deliberately. So is a block of rules that fight game loops and legacy naming: `camelcase`, `no-plusplus`, `no-continue`, `no-param-reassign`, `no-restricted-syntax`, and a dozen more, each with a one-line reason next to it in the config. `vitest/valid-title` and `vitest/expect-expect` are off for benchmark titles and helper-driven assertions.

**No `max-len`, on purpose.** Prettier owns line width through `printWidth`. An ESLint `max-len` would only fire on the lines Prettier cannot break, is not auto-fixable, and would block commits over a rare long expression. Prettier does not reflow comments or string contents, so a long comment passes both tools. Do not hand-wrap comments to hit 100 columns, because nothing enforces it.

**Not linted.** `ignorePatterns` in `.eslintrc.cjs` covers `dist/`, `node_modules/`, `coverage/`, `.prettierrc.cjs`, `.github/workflows/*.yml`, the generated weight modules `src/ai/*PolicyWeights.js`, and `bots/` plus `community-bots/`, whose files are bare function bodies with a top-level `return` rather than ES modules. A negation, `!src/ai/unpackPolicyWeights.js`, keeps the hand-written decoder linted, since the glob would otherwise swallow it. There is no `.eslintignore`.

## Prettier configuration

[Prettier](https://prettier.io/) owns formatting. `.prettierrc.cjs` sets:

- 100 character line width
- 2 space indentation, spaces rather than tabs
- Semicolons at the end of statements
- Single quotes in JavaScript, double quotes in JSX
- Quotes on object properties only where they are needed
- ES5-compatible trailing commas
- Spaces inside object braces, and a closing bracket on its own line
- No parentheses around a single arrow-function parameter
- LF line endings, and prose left exactly as written

`.prettierignore` keeps Prettier away from build output (`dist/`, `coverage/`), `package.json` and its lockfile, minified files, the generated weight modules `src/ai/*PolicyWeights.js` along with their parity fixtures in `tests/fixtures/bc/`, and the Python subproject `/ml/`, which has its own tooling. It carries the same `!src/ai/unpackPolicyWeights.js` negation as the ESLint list. Both lists match the weight modules by glob, so a newly exported `*PolicyWeights.js` is covered without a hand edit.

## Using the tools

### Linting

To check for linting issues:

```bash
npm run lint
```

That runs `eslint . --ext .js,.jsx,.mjs --max-warnings=100`. To fix what ESLint can fix on its own:

```bash
npm run lint:fix
```

### Formatting

To check if your code is properly formatted:

```bash
npm run format:check
```

To format your code:

```bash
npm run format
```

Both run Prettier across the whole repo, minus `.prettierignore`.

## Pre-commit hooks

The project uses [husky](https://github.com/typicode/husky) and [lint-staged](https://github.com/okonet/lint-staged) to lint and format changed files before each commit. The hook is `.husky/pre-commit`, which runs `npx lint-staged`; the file globs live in the `lint-staged` block of `package.json`.

On every commit:

1. Staged `.js`, `.jsx`, and `.mjs` files get `eslint --fix --max-warnings=100`, then `prettier --write`
2. Staged `.json`, `.md`, `.yml`, and `.yaml` files get `prettier --write`

If an issue can't be fixed automatically, the commit is blocked until you resolve it.

The Markdown pass has occasionally left a file that CI's `prettier --check` still rejects, usually around a multi-line inline-code span. If that happens, run `npx prettier --write <file>` yourself.

## Editor integration

The repo ships no editor settings, so this is per-developer setup. Configure your editor to run ESLint and Prettier for you.

### VS Code

Install these extensions:

- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

Then add these settings to your VS Code configuration:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "eslint.validate": ["javascript", "javascriptreact"]
}
```

`javascriptreact` matters here: the UI lives in `.jsx` files and is skipped without it.

### WebStorm / IntelliJ IDEA

These IDEs have built-in support for ESLint and Prettier:

1. Go to Preferences > Languages & Frameworks > JavaScript > Code Quality Tools > ESLint
2. Enable ESLint
3. Go to Preferences > Languages & Frameworks > JavaScript > Prettier
4. Enable Prettier

## Style rules overview

### JavaScript

- Use ES6+ features where appropriate
- Prefer arrow functions for callbacks and anonymous functions
- Use `const` for variables that aren't reassigned, and `let` for those that are
- Use object destructuring and spread syntax
- Prefer template literals over string concatenation
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Export individual items rather than a default export where possible
- Include JSDoc comments for functions and classes

### Naming conventions

- Use `camelCase` for variables, functions, and method names
- Use `PascalCase` for class and constructor names
- Use `UPPER_SNAKE_CASE` for constants
- Use descriptive names for variables and functions

### File organization

- One class or logical component per file
- Group related functions and classes in the same directory
- Import with relative paths and an explicit `.js` or `.jsx` extension. The project configures no path aliases.
- `src/ai/` and `src/engine/` each keep an `index.js` barrel, but most callers import the specific module directly (`../engine/AIAdapter.js`, `../ai/aiConfig.js`), which keeps the dependency visible. Either works.

### Comments

- Use JSDoc style comments for functions and classes
- Use block comments (`/* */`) for multi-line comments
- Use line comments (`//`) for single-line comments
- Keep comments up-to-date with code changes
