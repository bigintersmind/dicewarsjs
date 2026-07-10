/**
 * Difficulty-mode preset lineups (#167). Pins the exact bot mix each mode
 * represents — a lineup change should be a conscious roster decision that
 * shows up in this file's diff — plus the slice-to-player-count behavior and
 * the import-time validation that keeps every preset reproducible in the
 * Custom picker.
 */
import {
  DIFFICULTY_MODES,
  lineupForMode,
  assertValidLineup,
  LINEUP_SLOTS,
} from '../../src/ai/difficultyModes.js';
import { AI_STRATEGIES } from '../../src/ai/aiConfig.js';

describe('DIFFICULTY_MODES', () => {
  it('offers exactly easy, standard, hard — in ladder order (custom is UI-only)', () => {
    expect(Object.keys(DIFFICULTY_MODES)).toEqual(['easy', 'standard', 'hard']);
  });

  it('pins the Easy lineup: Example/Defensive-led, first Default at 5+ players', () => {
    expect(DIFFICULTY_MODES.easy.lineup).toEqual([
      null,
      'ai_example',
      'ai_defensive',
      'ai_example',
      'ai_default',
      'ai_defensive',
      'ai_example',
      'ai_default',
    ]);
  });

  it('pins the Standard lineup: original-game parity, every opponent ai_default', () => {
    expect(DIFFICULTY_MODES.standard.lineup).toEqual([null, ...Array(7).fill('ai_default')]);
  });

  it('pins the Hard lineup: the #164 persona-led roster, verbatim', () => {
    expect(DIFFICULTY_MODES.hard.lineup).toEqual([
      null,
      'ai_conqueror',
      'ai_blitz',
      'ai_survivor',
      'ai_lookahead',
      'ai_strategist',
      'ai_adaptive',
      'ai_default',
    ]);
  });

  it('gives every mode an id matching its key, a name, and a description', () => {
    for (const [key, mode] of Object.entries(DIFFICULTY_MODES)) {
      expect(mode.id).toBe(key);
      expect(mode.name).toBeTruthy();
      expect(mode.description).toBeTruthy();
    }
  });
});

describe('lineupForMode', () => {
  it('slices the lineup to the player count (slot 0 = human)', () => {
    expect(lineupForMode('easy', 2)).toEqual([null, 'ai_example']);
    expect(lineupForMode('easy', 7)).toEqual(DIFFICULTY_MODES.easy.lineup.slice(0, 7));
    expect(lineupForMode('hard', 8)).toEqual(DIFFICULTY_MODES.hard.lineup);
  });

  it('throws on an unknown mode id (custom included — it has no preset)', () => {
    expect(() => lineupForMode('custom', 7)).toThrow(/unknown difficulty mode/i);
    expect(() => lineupForMode('nightmare', 7)).toThrow(/unknown difficulty mode/i);
  });
});

describe('assertValidLineup (the import-time guard)', () => {
  const valid = [null, ...Array(LINEUP_SLOTS - 1).fill('ai_default')];

  it('accepts a valid lineup', () => {
    expect(() => assertValidLineup('test', valid)).not.toThrow();
  });

  it('rejects a lineup that is not exactly LINEUP_SLOTS long', () => {
    expect(() => assertValidLineup('test', valid.slice(0, 4))).toThrow(/exactly 8 slots/);
  });

  it('rejects a non-null slot 0 (the human seat)', () => {
    expect(() => assertValidLineup('test', ['ai_default', ...valid.slice(1)])).toThrow(/slot 0/);
  });

  it('rejects an id missing from the picker registry', () => {
    expect(() => assertValidLineup('test', [null, 'ai_typo', ...valid.slice(2)])).toThrow(
      /unknown bot id "ai_typo"/
    );
  });

  it('rejects a picker-hidden id — Custom could not reproduce the preset', () => {
    expect(AI_STRATEGIES.ai_expectimax.hidden).toBe(true);
    expect(() => assertValidLineup('test', [null, 'ai_expectimax', ...valid.slice(2)])).toThrow(
      /hidden from the picker/
    );
  });
});
