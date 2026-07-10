/**
 * Coverage for the Title Screen picker's built-in grouping
 * (`getAIStrategiesByCategory` in src/ai/aiConfig.js).
 *
 * The picker shows three sections — **Self-Play** (learned neural personas),
 * **General** (hand-written heuristics, strongest first), and **Community** —
 * with Self-Play on top. `getAIStrategiesByCategory` filters out entries flagged
 * `hidden` (the #164 roster trim), so this locks the Self-Play/General split,
 * the strongest-first General order, and the hidden filter, and — crucially —
 * keeps it in sync with the `persona`/`hidden` flags in builtInBots.js (the two
 * registries list the same bots from different files, so they can drift apart
 * silently otherwise).
 */
import { getAIStrategiesByCategory, AI_STRATEGIES } from '../../src/ai/aiConfig.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';

describe('getAIStrategiesByCategory', () => {
  it('puts exactly the self-play personas in the Self-Play group, in registry order', () => {
    const { selfPlay } = getAIStrategiesByCategory();
    expect(selfPlay.map(s => s.id)).toEqual(['ai_conqueror', 'ai_blitz', 'ai_survivor']);
    for (const s of selfPlay) expect(s.category).toBe('self-play');
  });

  it('lists the General heuristics strongest-first and never a persona (#164)', () => {
    const { general } = getAIStrategiesByCategory();
    expect(general.map(s => s.id)).toEqual([
      'ai_lookahead',
      'ai_strategist',
      'ai_adaptive',
      'ai_default',
    ]);
  });

  it('filters the hidden trimmed bots out of the picker (#164)', () => {
    const { selfPlay, general } = getAIStrategiesByCategory();
    const ids = [...selfPlay, ...general].map(s => s.id);
    for (const hid of ['ai_example', 'ai_defensive', 'ai_expectimax']) {
      expect(ids).not.toContain(hid);
      // Hidden ids still resolve — attract mode loads ai_defensive through the registry.
      expect(AI_STRATEGIES[hid]).toBeDefined();
      expect(AI_STRATEGIES[hid].hidden).toBe(true);
    }
  });

  it('partitions the un-hidden registry with no overlap and no drops', () => {
    const { selfPlay, general } = getAIStrategiesByCategory();
    const visible = Object.values(AI_STRATEGIES).filter(s => !s.hidden);
    expect(selfPlay.length + general.length).toBe(visible.length);
    const seen = new Set([...selfPlay, ...general].map(s => s.id));
    expect(seen.size).toBe(visible.length);
  });

  it('lists the same personas as the `persona` flag in builtInBots.js (no drift)', () => {
    const { selfPlay } = getAIStrategiesByCategory();
    const pickerPersonaIds = selfPlay.map(s => s.id).sort();
    const registryPersonaIds = BUILT_IN_BOTS.filter(b => b.persona)
      .map(b => b.id)
      .sort();
    expect(pickerPersonaIds).toEqual(registryPersonaIds);
  });

  it('hides the same bot set as builtInBots.js minus the registry-only nets (no drift)', () => {
    // builtInBots also hides BC/PPO, which have no AI_STRATEGIES entry at all.
    const configHidden = Object.values(AI_STRATEGIES)
      .filter(s => s.hidden)
      .map(s => s.id)
      .sort();
    const registryHidden = BUILT_IN_BOTS.filter(b => b.hidden && AI_STRATEGIES[b.id])
      .map(b => b.id)
      .sort();
    expect(configHidden).toEqual(registryHidden);
  });
});
