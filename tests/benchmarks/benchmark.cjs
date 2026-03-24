/**
 * AI Strategy Benchmark Runner (CommonJS version)
 *
 * A simplified version of the benchmark runner using CommonJS module system
 * for better compatibility with the existing project structure.
 *
 * Run with: node tests/benchmarks/benchmark.cjs
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const RESULTS_DIR = path.join(process.cwd(), 'benchmark-results');

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

console.log('\n===== Running AI Strategy Benchmarks =====');
console.log('This will execute the benchmark tests using Vitest\n');

// Set environment to enable benchmark tests
process.env.NODE_ENV = 'benchmark';

// Run the benchmark tests with increased timeouts
try {
  execSync('npx vitest run tests/benchmarks/ai.benchmark.js --testTimeout=30000', {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'benchmark' },
  });
  console.log('\n===== Benchmarks Complete =====');
  console.log(
    `\nBenchmark tests have completed. To run the full benchmark suite with visualizations:`
  );
  console.log(`1. Run: node tests/benchmarks/runBenchmarks.js`);
  console.log(`2. Check the benchmark-results/ directory for detailed reports`);
} catch (error) {
  console.error('Benchmark run failed:', error.message);
  process.exit(1);
}
