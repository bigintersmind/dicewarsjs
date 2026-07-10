/**
 * Registry contract for the built-in bot list ([D-27], #164).
 *
 * The persona roster and the curated player-visible roster ship behind two
 * orthogonal per-entry flags in `builtInBots.js`. Players see exactly seven
 * strength-ordered bots; the `hidden` flag covers both internal dev-harness nets
 * (`BC`/`PPO`) and trimmed heuristics (`Example`, `Defensive`, `Expectimax`)
 * from issue #164. That contract lives entirely in data (the `hidden`/`persona`
 * flags + the derived strength-ordered `PLAYER_VISIBLE_BOTS`), so a one-line
 * edit — dropping a `hidden: true`, forgetting a `persona: true`, or changing
 * the order — would silently re-leak bots or misorient the picker with every
 * other test still green. These assertions pin the exact split and order so
 * regression turns a test red.
 */
import { BUILT_IN_BOTS, PLAYER_VISIBLE_BOTS } from '../../src/arena/builtInBots.js';

const byName = name => BUILT_IN_BOTS.find(b => b.name === name);

describe('BUILT_IN_BOTS flags', () => {
  it('hides the internal dev-harness nets (BC, PPO) and the trimmed heuristics (#164)', () => {
    const hidden = BUILT_IN_BOTS.filter(b => b.hidden)
      .map(b => b.name)
      .sort();
    expect(hidden).toEqual(['BC', 'Defensive', 'Example', 'Expectimax', 'PPO']);
  });

  it('tags exactly the three personas as `persona`', () => {
    const personas = BUILT_IN_BOTS.filter(b => b.persona)
      .map(b => b.name)
      .sort();
    expect(personas).toEqual(['Blitz', 'Conqueror', 'Survivor']);
  });

  it('keeps `hidden` and `persona` orthogonal — no bot is both', () => {
    expect(BUILT_IN_BOTS.filter(b => b.hidden && b.persona)).toEqual([]);
  });
});

describe('PLAYER_VISIBLE_BOTS', () => {
  it('is the full roster minus the five hidden entries', () => {
    expect(PLAYER_VISIBLE_BOTS).toHaveLength(BUILT_IN_BOTS.length - 5);
  });

  it('lists the roster strongest-first: personas, then heuristics by strength (#164)', () => {
    expect(PLAYER_VISIBLE_BOTS.map(b => b.id)).toEqual([
      'ai_conqueror',
      'ai_blitz',
      'ai_survivor',
      'ai_lookahead',
      'ai_strategist',
      'ai_adaptive',
      'ai_default',
    ]);
  });

  it('never exposes a hidden bot', () => {
    const visible = PLAYER_VISIBLE_BOTS.map(b => b.name);
    for (const name of ['BC', 'PPO', 'Example', 'Defensive', 'Expectimax']) {
      expect(visible).not.toContain(name);
    }
  });

  it('contains only entries that are actually in BUILT_IN_BOTS (same object identity)', () => {
    for (const bot of PLAYER_VISIBLE_BOTS) {
      expect(byName(bot.name)).toBe(bot);
    }
  });
});
