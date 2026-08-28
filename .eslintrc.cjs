module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: ['plugin:vitest/recommended', 'plugin:prettier/recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['vitest', 'prettier', 'react'],
  rules: {
    // Prettier integration
    'prettier/prettier': ['error'],

    /*
     * Mark JSX-referenced bindings as used. This is a Preact project (JSX compiles
     * to h()/jsx()), and core no-unused-vars can't see that <TitleScreen /> uses the
     * `TitleScreen` import — without this rule every screen/component import is a
     * false-positive "unused". We enable ONLY this rule from eslint-plugin-react;
     * the rest of its React-centric ruleset doesn't apply to Preact.
     */
    'react/jsx-uses-vars': 'error',

    // ES6+ features
    'arrow-body-style': ['error', 'as-needed'],
    'arrow-parens': ['error', 'as-needed'],
    'prefer-arrow-callback': 'error',
    'prefer-const': 'error',
    'prefer-rest-params': 'error',
    'prefer-spread': 'error',
    'prefer-template': 'error',
    'template-curly-spacing': ['error', 'never'],

    // Additional modern JavaScript rules
    'no-var': 'error',
    'object-shorthand': ['error', 'always'],
    'no-useless-constructor': 'error',
    'no-useless-rename': 'error',
    'no-duplicate-imports': 'error',

    // Flag references to undeclared variables. This is OFF by default here because we don't
    // extend eslint:recommended; enabling it explicitly is the cheapest possible net for the
    // "ReferenceError at runtime" bug class (e.g. a typo'd or un-threaded identifier that lints
    // clean but throws on the first run). Test-file globals (describe/it/expect/vi/…) come from
    // the vitest env in the `overrides` block below, so they are not false-positived.
    'no-undef': 'error',

    // Allow console for game development
    'no-console': 'off',

    // Require a space after comment markers (auto-fixable)
    'spaced-comment': ['error', 'always'],

    // Line width is owned entirely by Prettier (printWidth: 100). We don't run a
    // separate ESLint max-len: it only fires on lines Prettier can't break, it
    // isn't auto-fixable, and it would just block commits on a rare long expression.

    // Allow non-camelcase identifiers (due to existing AI implementation)
    camelcase: ['off'],

    // Allow ++ operator for game logic (common in game loops/increments)
    'no-plusplus': ['off'],

    // Allow continue statements (common in game loops)
    'no-continue': ['off'],

    // Allow underscore prefixes for private members
    'no-underscore-dangle': ['off'],

    // Allow iterators (for...of) for game logic
    'no-restricted-syntax': ['off'],
    // Allow use-before-define for complex game logic
    'no-use-before-define': ['off'],
    // Relax unused vars for game development
    'no-unused-vars': ['warn'],
    // Allow no-param-reassign for game logic
    'no-param-reassign': ['off'],
    // Allow else after return in game logic
    'no-else-return': ['off'],
    // Allow no-shadow for complex game logic
    'no-shadow': ['warn'],
    // Allow no-prototype-builtins in test code
    'no-prototype-builtins': ['warn'],
    // Disable class-methods-use-this for game development
    'class-methods-use-this': ['off'],
    // Disable default-case for switch statements in game logic
    'default-case': ['off'],
    // Allow array-callback-return for array methods
    'array-callback-return': ['off'],
    // Allow global-require in tests
    'global-require': ['off'],
    // Allow prefer-destructuring in Game code
    'prefer-destructuring': ['off'],
    // Disable vitest/valid-title for benchmark titles
    'vitest/valid-title': ['off'],
    // Allow return-assign in test code
    'no-return-assign': ['off'],
    // Disable vitest/expect-expect in tests
    'vitest/expect-expect': ['off'],
    // Allow func-names in test files
    'func-names': ['off'],
  },
  overrides: [
    {
      // Vitest injects its globals (describe/it/expect/vi/beforeEach/afterEach/…) via
      // `globals: true` in vite.config.js — ESLint can't see that, so with `no-undef` on it would
      // false-positive every test. Scope the plugin's vitest env (supplied by eslint-plugin-vitest,
      // already a dependency) to test files so those globals resolve without a hand-maintained list.
      files: ['tests/**/*.{js,jsx,mjs}'],
      env: { 'vitest/env': true },
    },
  ],
  globals: {
    // Global functions available in newer Node.js versions
    structuredClone: 'readonly',
  },
  ignorePatterns: [
    // Build and generated
    'dist/',
    'node_modules/',
    'coverage/',
    // Generated model weights (compact single-line dump from export_weights.py; do not lint).
    // The glob also catches unpackPolicyWeights.js, the hand-written decoder, so exempt it.
    'src/ai/*PolicyWeights.js',
    '!src/ai/unpackPolicyWeights.js',

    // Config files
    '.prettierrc.cjs',

    // Bot files are bare function bodies (top-level return), not ES modules — skip them
    'bots/',
    'community-bots/',

    // GitHub Actions (managed by Prettier)
    '.github/workflows/*.yml',
  ],
};
