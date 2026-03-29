import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'path';

export default defineConfig({
  plugins: [preact()],

  resolve: {
    alias: {
      '@utils': path.resolve(import.meta.dirname, 'src/utils'),
      '@ai': path.resolve(import.meta.dirname, 'src/ai'),
      '@models': path.resolve(import.meta.dirname, 'src/models'),
      '@mechanics': path.resolve(import.meta.dirname, 'src/mechanics'),
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
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,cjs}', 'src/**/*.test.js', 'tests/benchmarks/*.benchmark.js'],
    globals: true,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/bridge/**/*.js'],
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
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
        'src/mechanics/**/*.js': {
          statements: 50,
          branches: 35,
          functions: 55,
          lines: 55,
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
});
