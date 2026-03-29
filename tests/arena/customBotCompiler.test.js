import { compileCustomBot } from '../../src/arena/customBotCompiler.js';

describe('compileCustomBot', () => {
  it('compiles valid bot source that returns a move', () => {
    const source = `
      for (const area of state.myAreas) {
        if (area.dice <= 1) continue;
        const enemy = area.neighbors.find(id => {
          const target = state.allAreas.find(a => a.id === id);
          return target && target.owner !== state.myPlayer;
        });
        if (enemy !== undefined) return { from: area.id, to: enemy };
      }
      return null;
    `;
    const { fn, warnings } = compileCustomBot(source, 'Test Bot');
    expect(typeof fn).toBe('function');
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('compiles a bot that always returns null', () => {
    const { fn, warnings } = compileCustomBot('return null;', 'Null Bot');
    expect(typeof fn).toBe('function');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('null');
  });

  it('throws on syntax errors', () => {
    expect(() => compileCustomBot('if (', 'Bad Bot')).toThrow('Syntax error');
  });

  it('throws on empty source', () => {
    expect(() => compileCustomBot('', 'Empty Bot')).toThrow();
  });

  it('throws on runtime errors', () => {
    expect(() => compileCustomBot('throw new Error("boom");', 'Crash Bot')).toThrow(
      'Runtime error: boom'
    );
  });

  it('throws when bot returns a non-object', () => {
    expect(() => compileCustomBot('return 42;', 'Number Bot')).toThrow(
      'Bot must return { from, to } or null'
    );
  });

  it('throws when bot returns object without from/to numbers', () => {
    expect(() => compileCustomBot('return { from: "a", to: "b" };', 'String Bot')).toThrow(
      'Bot must return { from: number, to: number }'
    );
  });

  it('throws when bot returns object with missing to', () => {
    expect(() => compileCustomBot('return { from: 1 };', 'Partial Bot')).toThrow(
      'Bot must return { from: number, to: number }'
    );
  });

  it('warns when bot returns undefined (no explicit return)', () => {
    const { warnings } = compileCustomBot('const x = 1;', 'NoReturn Bot');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('null');
  });

  it('handles non-Error thrown values in bot code', () => {
    expect(() => compileCustomBot('throw "string error";', 'Throw String Bot')).toThrow(
      'Runtime error: string error'
    );
  });

  it('sets botName on the compiled function', () => {
    const { fn } = compileCustomBot('return null;', 'Named Bot');
    expect(fn.botName).toBe('Named Bot');
  });
});
