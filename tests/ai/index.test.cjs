/**
 * Tests for AI index module using CommonJS (for Jest compatibility)
 */
const ai = require('../../src/ai/index.js');

describe('AI Index Module', () => {
  it('should export all expected components', () => {
    // Test that loaders are available (from aiConfig.js)
    expect(typeof ai.load_ai_default).toBe('function');
    expect(typeof ai.load_ai_defensive).toBe('function');
    expect(typeof ai.load_ai_example).toBe('function');
    expect(typeof ai.load_ai_adaptive).toBe('function');
    expect(typeof ai.load_ai_claude).toBe('function');
    expect(typeof ai.load_ai_codex).toBe('function');

    // Test that strategies and helpers exist
    expect(typeof ai.AI_STRATEGIES).toBe('object');
    expect(typeof ai.getAIImplementation).toBe('function');

    // Test strategy metadata
    expect(ai.AI_STRATEGIES.ai_default).toBeDefined();
    expect(ai.AI_STRATEGIES.ai_default.name).toBe('Balanced AI');
    expect(ai.AI_STRATEGIES.ai_codex).toBeDefined();
    expect(ai.AI_STRATEGIES.ai_codex.name).toBe('Codex AI');
  });
});
