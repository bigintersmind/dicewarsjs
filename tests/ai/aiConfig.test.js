/**
 * Coverage for the Title Screen picker's built-in grouping
 * (`getAIStrategiesByCategory` in src/ai/aiConfig.js).
 *
 * The picker shows three sections — **Self-Play** (learned neural personas),
 * **General** (hand-written heuristics), and **Community** — with Self-Play on
 * top. This locks the Self-Play/General split and, crucially, keeps it in sync
 * with the `persona` flag in builtInBots.js (the two registries list the same
 * personas from different files, so they can drift apart silently otherwise).
 */
import { getAIStrategiesByCategory, AI_STRATEGIES } from '../../src/ai/aiConfig.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';

describe('getAIStrategiesByCategory', () => {
  it('puts exactly the self-play personas in the Self-Play group, in registry order', () => {
    const { selfPlay } = getAIStrategiesByCategory();
    expect(selfPlay.map(s => s.id)).toEqual(['ai_conqueror', 'ai_blitz', 'ai_survivor']);
    // Every entry is tagged, so the picker groups it under Self-Play.
    for (const s of selfPlay) expect(s.category).toBe('self-play');
  });

  it('puts the hand-written heuristics in General and never a persona', () => {
    const { general } = getAIStrategiesByCategory();
    const ids = general.map(s => s.id);
    expect(ids).toContain('ai_default');
    expect(ids).toContain('ai_lookahead');
    expect(ids).not.toContain('ai_conqueror');
    expect(ids).not.toContain('ai_blitz');
    expect(ids).not.toContain('ai_survivor');
  });

  it('partitions the full registry with no overlap and no drops', () => {
    const { selfPlay, general } = getAIStrategiesByCategory();
    const all = Object.values(AI_STRATEGIES);
    expect(selfPlay.length + general.length).toBe(all.length);
    const seen = new Set([...selfPlay, ...general].map(s => s.id));
    expect(seen.size).toBe(all.length); // disjoint union
  });

  it('lists the same personas as the `persona` flag in builtInBots.js (no drift)', () => {
    const { selfPlay } = getAIStrategiesByCategory();
    const pickerPersonaIds = selfPlay.map(s => s.id).sort();
    const registryPersonaIds = BUILT_IN_BOTS.filter(b => b.persona)
      .map(b => b.id)
      .sort();
    expect(pickerPersonaIds).toEqual(registryPersonaIds);
  });
});
