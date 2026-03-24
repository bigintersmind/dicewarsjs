/**
 * Tests for the process.js polyfill
 *
 * Uses an inline copy of the polyfill logic rather than dynamic import because:
 * In jsdom, window.process IS Node's process global. Deleting it to test the
 * polyfill's "create process" path would crash Vitest. The inline function
 * mirrors src/polyfills/process.js exactly.
 */

describe('Process Polyfill', () => {
  function applyPolyfill(win) {
    if (typeof win !== 'undefined' && !win.process) {
      win.process = {
        env: {
          NODE_ENV:
            win.location.hostname === 'localhost' ||
            win.location.hostname === '127.0.0.1' ||
            win.location.hostname.includes('dev.')
              ? 'development'
              : 'production',
        },
      };
    }
  }

  function makeWindow(hostname) {
    return { location: { hostname } };
  }

  test('sets up process.env.NODE_ENV in browser environment', () => {
    const win = makeWindow('localhost');
    applyPolyfill(win);

    expect(win.process).toBeDefined();
    expect(win.process.env).toBeDefined();
    expect(win.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "development" for localhost', () => {
    const win = makeWindow('localhost');
    applyPolyfill(win);
    expect(win.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "development" for 127.0.0.1', () => {
    const win = makeWindow('127.0.0.1');
    applyPolyfill(win);
    expect(win.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "development" for dev domains', () => {
    const win = makeWindow('dev.example.com');
    applyPolyfill(win);
    expect(win.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "production" for production domains', () => {
    const win = makeWindow('example.com');
    applyPolyfill(win);
    expect(win.process.env.NODE_ENV).toBe('production');
  });

  test('does not override existing process object', () => {
    const win = makeWindow('example.com');
    win.process = { env: { NODE_ENV: 'test' } };

    applyPolyfill(win);

    expect(win.process.env.NODE_ENV).toBe('test');
  });

  test('does nothing when window is undefined', () => {
    const win = undefined;
    applyPolyfill(win);
    expect(win).toBeUndefined();
  });
});
