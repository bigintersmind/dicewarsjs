import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'path';

export default defineConfig(({ command }) => ({
  /*
   * GitHub Pages serves this project at https://ivanlay.com/dicewarsjs/, so the
   * production build must emit subpath-relative asset URLs. Dev/test stay at '/'.
   */
  base: command === 'build' ? '/dicewarsjs/' : '/',

  plugins: [preact({ devToolsEnabled: false })],

  resolve: {
    alias: {
      '@utils': path.resolve(import.meta.dirname, 'src/utils'),
      '@ai': path.resolve(import.meta.dirname, 'src/ai'),
      '@models': path.resolve(import.meta.dirname, 'src/models'),
      '@state': path.resolve(import.meta.dirname, 'src/state'),
      '@engine': path.resolve(import.meta.dirname, 'src/engine'),
    },
  },

  server: {
    port: 3000,
    open: true,
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ['pixi.js'],
        },
      },
    },
  },

  test: {
    /*
     * jsdom boots a full DOM in every worker (~150-400MB each), but most of the
     * suite is pure engine/AI/model logic that never touches the DOM. Default to
     * the lightweight Node environment; the ~18 browser-facing suites opt back
     * into jsdom with a `// @vitest-environment jsdom` docblock at the top of the
     * file. This slashes per-run memory and speeds the suite up. New DOM tests
     * (touching document/window/localStorage) must add that docblock.
     */
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,cjs}', 'src/**/*.test.js', 'tests/benchmarks/*.benchmark.js'],
    globals: true,
    /*
     * Cap forked workers so a single run can't grab every core, and so several
     * concurrent runs (e.g. parallel Claude Code subagents) can't multiply their
     * jsdom workers into an out-of-memory crash. '50%' = 4 workers on 8 cores.
     * Pair this with the machine-wide lock in `npm test` (scripts/test-lock.sh),
     * which keeps separate runs from overlapping in the first place.
     */
    maxWorkers: '50%',
    minWorkers: 1,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        // Global floor set to current reality (~57.7%); raise as coverage improves.
        statements: 55,
        branches: 50,
        functions: 60,
        lines: 55,
        'src/utils/**/*.js': {
          statements: 30,
          branches: 25,
          functions: 30,
          lines: 30,
        },
        'src/models/**/*.js': {
          statements: 70,
          branches: 60,
          functions: 70,
          lines: 70,
        },
        'src/engine/**/*.js': {
          statements: 70,
          branches: 50,
          functions: 70,
          lines: 70,
        },
        'src/arena/**/*.js': {
          statements: 70,
          branches: 50,
          functions: 70,
          lines: 70,
        },
      },
    },
  },
}));
