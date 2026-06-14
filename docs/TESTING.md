# Testing Strategy for Dice Wars JS

This document outlines the testing strategy for the Dice Wars JS project as part of its modernization to ES6 modules.

## Overview

Our testing approach focuses on ensuring the reliability and correctness of the project's ES6 module codebase. We've implemented a comprehensive testing strategy using Jest as our testing framework.

## Testing Framework

We use **Jest** as our primary testing framework because it provides:

- A comprehensive test runner with parallel test execution
- Built-in assertion library
- Mocking capabilities for modules and browser APIs
- Coverage reporting
- Watch mode for development

## Directory Structure

Tests are organized to mirror the source code structure:

```
/tests
  /mocks          # Mock files for testing
  /utils          # Tests for utility modules
    gameUtils.test.js
    render.test.js
    sound.test.js
    config.test.js
  /models         # Tests for data models
  /ai             # Tests for AI strategies
  setup.js        # Global test setup
```

## Test Types

### 1. Unit Tests

Unit tests focus on testing individual functions and modules in isolation. These tests verify that each unit of code behaves as expected.

Examples:

- Testing game utility functions (dice rolling, attack probability)
- Testing rendering functions
- Testing configuration management

### 2. Integration Tests

Integration tests verify that different modules work together correctly.

Examples:

- Testing interactions between game state and rendering

### 3. Functional Tests

Functional tests verify that the application works correctly from a user's perspective. These tests ensure that the game's features work as expected.

Examples:

- Testing game initialization
- Testing game mechanics (attacks, turns)
- Testing AI behavior

## Mocking Strategy

We use various mocking techniques to isolate the code being tested:

1. **Browser APIs**: We mock browser APIs like `localStorage` and the canvas/audio APIs
2. **Module Dependencies**: We mock module dependencies to isolate units of code
3. **DOM Elements**: We use the JSDOM environment provided by Jest

## Code Coverage

We track code coverage to ensure our tests are comprehensive. Our goal is to maintain:

- 80%+ line coverage for utility modules
- 70%+ line coverage for game logic

To run tests with coverage:

```bash
npm test -- --coverage
```

## Running Tests

To run all tests:

```bash
npm test
```

To run tests in watch mode during development:

```bash
npm run test:watch
```

To run specific tests:

```bash
npm test -- -t "Game Utilities"
```

## Writing Tests

Guidelines for writing tests:

1. **Test Names**: Use descriptive names that indicate what is being tested
2. **AAA Pattern**: Structure tests with Arrange, Act, Assert
3. **Isolation**: Ensure tests are isolated and do not depend on other tests
4. **Mocks**: Prefer explicit mocks over global mocks
5. **Assertions**: Use specific assertions that clearly indicate what's being verified

Example of a well-structured test:

```javascript
test('calculates attack probability correctly for advantage scenario', () => {
  // Arrange
  const attackerDice = 5;
  const defenderDice = 2;

  // Act
  const probability = calculateAttackProbability(attackerDice, defenderDice);

  // Assert
  expect(probability).toBeGreaterThan(0.5);
  expect(probability).toBeLessThan(0.95);
});
```

## Continuous Integration

Tests are integrated into our build process:

1. Tests run before building the production version
2. Pull requests require passing tests
3. Test coverage reports are generated and reviewed

## Best Practices

1. **Test Behavior, Not Implementation**: Focus on testing what the code does, not how it's implemented
2. **Small, Focused Tests**: Keep tests small and focused on a single behavior
3. **Maintainable Tests**: Write tests that are easy to understand and maintain
4. **Fast Tests**: Ensure tests run quickly to maintain a good development workflow
5. **Independent Tests**: Make tests independent of each other
6. **Deterministic Tests**: Avoid non-deterministic tests that sometimes pass and sometimes fail

## Future Improvements

As we continue the migration to ES6 modules, we plan to:

1. Add more integration tests for game mechanics
2. Implement component testing for UI elements
3. Add performance testing for critical game operations
4. Implement end-to-end testing for complete game scenarios

## Future Testing Plans

The project will migrate from Jest to Vitest as part of the modernization. See [MODERNIZATION_ROADMAP.md](./MODERNIZATION_ROADMAP.md) for details on the testing strategy across all phases.
