/**
 * Tests for AI index module
 */
import * as ai from '../../src/ai/index.js';

describe('AI Index Module', () => {
  it('should export AI loader functions instead of direct implementations', () => {
    // AI strategies are now loaded dynamically via loader functions
    expect(typeof ai.load_ai_default).toBe('function');
    expect(typeof ai.load_ai_defensive).toBe('function');
    expect(typeof ai.load_ai_example).toBe('function');
    expect(typeof ai.load_ai_adaptive).toBe('function');
    expect(typeof ai.load_ai_strategist).toBe('function');
    expect(typeof ai.load_ai_lookahead).toBe('function');
  });

  it('should export AI configuration utilities', () => {
    // Test that loader functions and strategies are exported
    expect(typeof ai.load_ai_default).toBe('function');
    expect(typeof ai.load_ai_defensive).toBe('function');
    expect(typeof ai.load_ai_example).toBe('function');
    expect(typeof ai.load_ai_adaptive).toBe('function');
    expect(typeof ai.load_ai_strategist).toBe('function');
    expect(typeof ai.load_ai_lookahead).toBe('function');
    expect(typeof ai.AI_STRATEGIES).toBe('object');
  });

  it('should export AI helpers', () => {
    // Test that helpers are available
    expect(typeof ai.getAIImplementation).toBe('function');
    // AI_STRATEGIES should contain metadata
    expect(ai.AI_STRATEGIES.ai_default).toBeDefined();
    expect(ai.AI_STRATEGIES.ai_default.name).toBe('Balanced AI');
    expect(ai.AI_STRATEGIES.ai_lookahead).toBeDefined();
    expect(ai.AI_STRATEGIES.ai_lookahead.name).toBe('Lookahead AI');
  });

  it('should load AI implementations dynamically', async () => {
    // Test that loader functions return actual implementations
    const defaultAI = await ai.load_ai_default();
    const defensiveAI = await ai.load_ai_defensive();
    const exampleAI = await ai.load_ai_example();
    const adaptiveAI = await ai.load_ai_adaptive();
    const strategistAI = await ai.load_ai_strategist();
    const lookaheadAI = await ai.load_ai_lookahead();

    expect(typeof defaultAI).toBe('function');
    expect(typeof defensiveAI).toBe('function');
    expect(typeof exampleAI).toBe('function');
    expect(typeof adaptiveAI).toBe('function');
    expect(typeof strategistAI).toBe('function');
    expect(typeof lookaheadAI).toBe('function');
  });
});
