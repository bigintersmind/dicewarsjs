import {
  getArg,
  getPositionalArg,
  hasFlag,
  loadBotSource,
  toTitleCase,
} from '../../scripts/lib/cli-utils.mjs';

describe('cli-utils', () => {
  describe('getArg', () => {
    it('returns default when flag is missing', () => {
      expect(getArg([], 'games', '100')).toBe('100');
    });

    it('returns value when flag is present', () => {
      expect(getArg(['--games', '50'], 'games', '100')).toBe('50');
    });

    it('returns default when flag is last arg (no value)', () => {
      expect(getArg(['--games'], 'games', '100')).toBe('100');
    });

    it('handles multiple flags', () => {
      const args = ['--bots', 'Default', '--games', '25'];
      expect(getArg(args, 'games', '100')).toBe('25');
      expect(getArg(args, 'bots', null)).toBe('Default');
    });
  });

  describe('getPositionalArg', () => {
    it('returns null when no args', () => {
      expect(getPositionalArg([])).toBeNull();
    });

    it('returns first non-flag arg', () => {
      expect(getPositionalArg(['my-bot'])).toBe('my-bot');
    });

    it('skips flags and their values', () => {
      expect(getPositionalArg(['--template', 'greedy', 'my-bot'])).toBe('my-bot');
    });

    it('returns first positional among mixed args', () => {
      expect(getPositionalArg(['bot-file.js', '--games', '10'])).toBe('bot-file.js');
    });

    it('returns null when all args are flags', () => {
      expect(getPositionalArg(['--template', 'greedy', '--test'])).toBeNull();
    });
  });

  describe('hasFlag', () => {
    it('returns false when flag is absent', () => {
      expect(hasFlag([], 'test')).toBe(false);
    });

    it('returns true when flag is present', () => {
      expect(hasFlag(['--test'], 'test')).toBe(true);
    });

    it('does not match partial flags', () => {
      expect(hasFlag(['--testing'], 'test')).toBe(false);
    });
  });

  describe('loadBotSource', () => {
    it('reads an existing bot file', () => {
      const source = loadBotSource('bots/random-bot.js');
      expect(source).toContain('state.myAreas');
    });

    it('throws for a missing file', () => {
      expect(() => loadBotSource('bots/nonexistent-bot.js')).toThrow('File not found');
    });
  });

  describe('toTitleCase', () => {
    it('converts kebab-case to Title Case', () => {
      expect(toTitleCase('my-bot')).toBe('My Bot');
    });

    it('handles single word', () => {
      expect(toTitleCase('aggressive')).toBe('Aggressive');
    });

    it('handles multiple hyphens', () => {
      expect(toTitleCase('super-smart-bot')).toBe('Super Smart Bot');
    });
  });
});
