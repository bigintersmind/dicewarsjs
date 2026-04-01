import { compileSandboxedBot } from '../../scripts/lib/bot-sandbox.mjs';

describe('compileSandboxedBot', () => {
  it('compiles valid bot source and returns moves', () => {
    const source = `
      const area = state.myAreas.find(a => a.dice > 1);
      if (!area) return null;
      return { from: area.id, to: 1 };
    `;
    const fn = compileSandboxedBot(source, 'test-bot');
    expect(typeof fn).toBe('function');

    const result = fn({
      myAreas: [{ id: 0, dice: 3 }],
      allAreas: [],
      myPlayer: 0,
    });
    expect(result).toEqual({ from: 0, to: 1 });
  });

  it('returns null for end-of-turn', () => {
    const fn = compileSandboxedBot('return null;', 'null-bot');
    expect(fn({ myAreas: [], allAreas: [], myPlayer: 0 })).toBeNull();
  });

  it('throws on invalid JavaScript syntax', () => {
    expect(() => compileSandboxedBot('function {{{', 'bad-bot')).toThrow();
  });

  it('bot code cannot access require, process, or fs', () => {
    const fn = compileSandboxedBot(
      'return { r: typeof require, p: typeof process, f: typeof fs };',
      'globals-test'
    );
    const result = fn({});
    expect(result.r).toBe('undefined');
    expect(result.p).toBe('undefined');
    expect(result.f).toBe('undefined');
  });

  it('times out on infinite loop and returns null', () => {
    const fn = compileSandboxedBot('while(true) {}', 'loop-bot', 100);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = fn({});
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));

    warnSpy.mockRestore();
  });

  it('wraps runtime errors with bot name', () => {
    const fn = compileSandboxedBot('throw new Error("intentional");', 'error-bot');
    expect(() => fn({})).toThrow(/error-bot.*runtime error/);
  });
});
