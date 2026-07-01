/**
 * Registry contract for the built-in bot list ([D-27]).
 *
 * The persona roster ships behind two orthogonal per-entry flags in
 * `builtInBots.js`, and the whole point of D-27 is that players see the three
 * personas and NOT the internal `BC`/`PPO` nets. That contract lives entirely in
 * data (the `hidden`/`persona` flags + the derived `PLAYER_VISIBLE_BOTS`), so a
 * one-line edit — dropping a `hidden: true`, forgetting a `persona: true`, or
 * changing the `.filter` — would silently re-leak an internal net into the
 * in-game picker / Arena / Tournament screens with every other test still green.
 * These assertions pin the exact split so that regression turns a test red.
 */
import { BUILT_IN_BOTS, PLAYER_VISIBLE_BOTS } from '../../src/arena/builtInBots.js';

const byName = name => BUILT_IN_BOTS.find(b => b.name === name);

describe('BUILT_IN_BOTS flags', () => {
  it('hides exactly the internal dev-harness nets (BC, PPO)', () => {
    const hidden = BUILT_IN_BOTS.filter(b => b.hidden)
      .map(b => b.name)
      .sort();
    expect(hidden).toEqual(['BC', 'PPO']);
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
  it('is the full roster minus the hidden nets', () => {
    // Derived as `BUILT_IN_BOTS.filter(b => !b.hidden)`; BC + PPO are the only hidden entries.
    expect(PLAYER_VISIBLE_BOTS).toHaveLength(BUILT_IN_BOTS.length - 2);
  });

  it('shows the three personas to players and hides BC/PPO', () => {
    const visible = PLAYER_VISIBLE_BOTS.map(b => b.name);
    expect(visible).toEqual(expect.arrayContaining(['Conqueror', 'Blitz', 'Survivor']));
    expect(visible).not.toContain('BC');
    expect(visible).not.toContain('PPO');
  });

  it('contains only entries that are actually in BUILT_IN_BOTS (same object identity)', () => {
    for (const bot of PLAYER_VISIBLE_BOTS) {
      expect(byName(bot.name)).toBe(bot);
    }
  });
});
