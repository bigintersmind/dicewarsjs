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
 *
 * Since #167, Defensive/Basic are picker-visible again (Easy-mode ingredients) while
 * staying hidden on the arena side — the two registries' hidden sets intentionally differ.
 */
import { getAIStrategiesByCategory, AI_STRATEGIES } from '../../src/ai/aiConfig.js';
import { BUILT_IN_BOTS, PLAYER_VISIBLE_BOTS } from '../../src/arena/builtInBots.js';

describe('getAIStrategiesByCategory', () => {
  it('puts exactly the self-play personas in the Self-Play group, in registry order', () => {
    const { selfPlay } = getAIStrategiesByCategory();
    expect(selfPlay.map(s => s.id)).toEqual(['ai_conqueror', 'ai_blitz', 'ai_survivor']);
    for (const s of selfPlay) expect(s.category).toBe('self-play');
  });

  it('lists the General heuristics strongest-first, revived weak bots last (#167)', () => {
    const { general } = getAIStrategiesByCategory();
    expect(general.map(s => s.id)).toEqual([
      'ai_lookahead',
      'ai_strategist',
      'ai_adaptive',
      'ai_default',
      'ai_defensive',
      'ai_example',
    ]);
  });

  it('hides only ai_expectimax from the picker (#167 revived Defensive/Basic)', () => {
    const { selfPlay, general } = getAIStrategiesByCategory();
    const ids = [...selfPlay, ...general].map(s => s.id);
    // Expectimax stays trimmed everywhere: strength-duplicate of Lookahead.
    expect(ids).not.toContain('ai_expectimax');
    expect(AI_STRATEGIES.ai_expectimax.hidden).toBe(true);
    // Defensive/Basic are revived in the picker (Easy-mode ingredients, #167) …
    expect(ids).toContain('ai_defensive');
    expect(ids).toContain('ai_example');
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

  it('orders the picker as PLAYER_VISIBLE_BOTS plus the revived tail (#167)', () => {
    // The picker (Self-Play above General) extends the arena-side strength order
    // with the two picker-only revived bots at the bottom. The prefix must stay
    // byte-identical to PLAYER_VISIBLE_BOTS so the two hand-ordered registries
    // can't drift; the tail is picker-only by design (competitive surfaces keep
    // the curated 7).
    const { selfPlay, general } = getAIStrategiesByCategory();
    expect([...selfPlay, ...general].map(s => s.id)).toEqual([
      ...PLAYER_VISIBLE_BOTS.map(b => b.id),
      'ai_defensive',
      'ai_example',
    ]);
  });

  it('pins the intended hidden-flag divergence between the two registries (#167)', () => {
    // Since #167 the flags MEAN different things: aiConfig.hidden = "not offered
    // in the game-setup picker"; builtInBots.hidden = "not on competitive
    // surfaces" (Arena/Tournament screens, CLI arena, online tournament).
    // Defensive/Basic are picker-visible but stay off competitive surfaces.
    const configHidden = Object.values(AI_STRATEGIES)
      .filter(s => s.hidden)
      .map(s => s.id)
      .sort();
    expect(configHidden).toEqual(['ai_expectimax']);

    const registryHidden = BUILT_IN_BOTS.filter(b => b.hidden && AI_STRATEGIES[b.id])
      .map(b => b.id)
      .sort();
    expect(registryHidden).toEqual(['ai_defensive', 'ai_example', 'ai_expectimax']);
  });
});
