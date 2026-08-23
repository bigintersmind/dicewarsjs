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

[ESLint](https://eslint.org/) checks code quality. The configuration:

- Extends the `airbnb-base` style guide
- Includes plugins for import, Jest, and Prettier
- Allows ES6+ features (optional chaining, nullish coalescing, etc.)
- Adds custom rules where game code needs them

## Prettier configuration

[Prettier](https://prettier.io/) formats the code. The configuration specifies:

- 100 character line width
- 2 space indentation
- Single quotes for strings
- ES5-compatible trailing commas
- No semicolons at the end of statements

## Using the tools

### Linting

To check for linting issues:

```bash
npm run lint
```

To fix linting issues where possible:

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

## Pre-commit hooks

The project uses [husky](https://github.com/typicode/husky) and [lint-staged](https://github.com/okonet/lint-staged) to run linting and formatting on changed files before each commit.

On every commit:

1. ESLint checks the staged JavaScript files and fixes what it can
2. Prettier formats all staged files according to our style rules

If an issue can't be fixed automatically, the commit is blocked until you resolve it.

## Editor integration

Configure your editor to run ESLint and Prettier for you.

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
    "source.fixAll.eslint": true
  },
  "eslint.validate": ["javascript"]
}
```

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
- Use index.js files to consolidate exports

### Comments

- Use JSDoc style comments for functions and classes
- Use block comments (`/* */`) for multi-line comments
- Use line comments (`//`) for single-line comments
- Keep comments up-to-date with code changes
