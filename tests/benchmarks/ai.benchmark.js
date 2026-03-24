/**
 * AI Strategy Benchmarks
 *
 * Measures and compares performance of all AI strategies
 */
import { AIBenchmark, createBenchmarkGameState } from './AIBenchmark.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { ai_default } from '../../src/ai/ai_default.js';
import { ai_defensive } from '../../src/ai/ai_defensive.js';
import { ai_adaptive } from '../../src/ai/ai_adaptive.js';

/**
 * Individual AI strategy benchmarks
 * Tests each AI strategy in isolation with standard game state
 */
describe('AI Strategy Performance Benchmarks', () => {
  // Use smaller iteration counts for vitest test environment
  const ITERATIONS = 100;
  const WARMUP_RUNS = 5;
  const SMALL_ITERATIONS = 20; // For more complex AIs

  let benchmark;
  let standardGameState;

  beforeAll(() => {
    // Disable console logging during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});

    benchmark = new AIBenchmark({
      iterations: ITERATIONS,
      warmupRuns: WARMUP_RUNS,
      logResults: false,
    });

    standardGameState = createBenchmarkGameState();
  });

  afterAll(() => {
    // Restore console logging
    console.log.mockRestore();
  });

  test('Example AI performance benchmark', () => {
    const result = benchmark.measurePerformance('ai_example', ai_example, standardGameState);

    expect(result).toBeDefined();
    expect(result.averageTime).toBeGreaterThan(0);
    expect(result.iterations).toBe(ITERATIONS);
    expect(result.decisions.length).toBe(ITERATIONS);
  });

  test('Default AI performance benchmark', () => {
    const result = benchmark.measurePerformance('ai_default', ai_default, standardGameState);

    expect(result).toBeDefined();
    expect(result.averageTime).toBeGreaterThan(0);
    expect(result.iterations).toBe(ITERATIONS);
    expect(result.decisions.length).toBe(ITERATIONS);
  });

  test('Defensive AI performance benchmark', () => {
    // Use smaller iteration count for more complex AIs
    const defensiveBenchmark = new AIBenchmark({
      iterations: SMALL_ITERATIONS,
      warmupRuns: WARMUP_RUNS,
      logResults: false,
    });

    const result = defensiveBenchmark.measurePerformance(
      'ai_defensive',
      ai_defensive,
      standardGameState
    );

    expect(result).toBeDefined();
    expect(result.averageTime).toBeGreaterThan(0);
    expect(result.iterations).toBe(SMALL_ITERATIONS);
    expect(result.decisions.length).toBe(SMALL_ITERATIONS);
  });

  test('Adaptive AI performance benchmark', () => {
    // Use smaller iteration count for most complex AI
    const adaptiveBenchmark = new AIBenchmark({
      iterations: SMALL_ITERATIONS,
      warmupRuns: WARMUP_RUNS,
      logResults: false,
    });

    const result = adaptiveBenchmark.measurePerformance(
      'ai_adaptive',
      ai_adaptive,
      standardGameState
    );

    expect(result).toBeDefined();
    expect(result.averageTime).toBeGreaterThan(0);
    expect(result.iterations).toBe(SMALL_ITERATIONS);
    expect(result.decisions.length).toBe(SMALL_ITERATIONS);
  });
});

/**
 * Strategy Comparison Benchmark
 * Compares all AI strategies side-by-side
 */
describe('AI Strategy Comparison Benchmark', () => {
  /*
   * Only skip when running Vitest's normal test suite - run it during benchmarks
   * Run with: NODE_ENV=benchmark vitest run -t "Compare all AI strategies"
   */
  test(
    process.env.NODE_ENV === 'benchmark'
      ? 'Compare all AI strategies'
      : 'SKIPPED: Compare all AI strategies',
    () => {
      const benchmark = new AIBenchmark({
        iterations: 50,
        warmupRuns: 5,
        logResults: true, // Enable logging for comparison
      });

      const gameState = createBenchmarkGameState();

      const results = benchmark.compareStrategies(
        [
          { name: 'Example AI', function: ai_example },
          { name: 'Default AI', function: ai_default },
          { name: 'Defensive AI', function: ai_defensive },
          { name: 'Adaptive AI', function: ai_adaptive },
        ],
        gameState
      );

      // Simple validation
      expect(results).toBeDefined();
      expect(Object.keys(results).length).toBe(4);
      expect(results['Example AI']).toBeDefined();
      expect(results['Default AI']).toBeDefined();
      expect(results['Defensive AI']).toBeDefined();
      expect(results['Adaptive AI']).toBeDefined();
    }
  );
});
