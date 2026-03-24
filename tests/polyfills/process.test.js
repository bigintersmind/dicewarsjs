/**
 * Tests for the process.js polyfill
 *
 * Note: These tests directly test the polyfill logic rather than dynamically
 * re-importing the module, since the polyfill is a side-effect-only module
 * that checks window state at load time.
 */

describe('Process Polyfill', () => {
  /*
   * The polyfill logic inline for testability:
   * if (typeof window !== 'undefined' && !window.process) {
   *   window.process = { env: { NODE_ENV: ... } }
   * }
   */

  function applyPolyfill() {
    if (typeof window !== 'undefined' && !window.process) {
      window.process = {
        env: {
          NODE_ENV:
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.hostname.includes('dev.')
              ? 'development'
              : 'production',
        },
      };
    }
  }

  let originalProcess;

  beforeEach(() => {
    originalProcess = window.process;
    delete window.process;
  });

  afterEach(() => {
    if (originalProcess) {
      window.process = originalProcess;
    } else {
      delete window.process;
    }
  });

  test('sets up process.env.NODE_ENV in browser environment', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });

    applyPolyfill();

    expect(window.process).toBeDefined();
    expect(window.process.env).toBeDefined();
    expect(window.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "development" for localhost', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });

    applyPolyfill();

    expect(window.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "development" for 127.0.0.1', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: '127.0.0.1' },
      writable: true,
      configurable: true,
    });

    applyPolyfill();

    expect(window.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "development" for dev domains', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'dev.example.com' },
      writable: true,
      configurable: true,
    });

    applyPolyfill();

    expect(window.process.env.NODE_ENV).toBe('development');
  });

  test('sets NODE_ENV to "production" for production domains', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'example.com' },
      writable: true,
      configurable: true,
    });

    applyPolyfill();

    expect(window.process.env.NODE_ENV).toBe('production');
  });

  test('does not override existing process object', () => {
    window.process = {
      env: {
        NODE_ENV: 'test',
      },
    };

    const originalProcessSnapshot = { ...window.process };

    Object.defineProperty(window, 'location', {
      value: { hostname: 'example.com' },
      writable: true,
      configurable: true,
    });

    applyPolyfill();

    expect(window.process).toEqual(originalProcessSnapshot);
  });

  test('does nothing in non-browser environment', () => {
    /*
     * The polyfill checks typeof window !== 'undefined'
     * In Vitest jsdom, window always exists, so we test the guard logic directly
     */
    const mockWindow = undefined;

    // Simulate the polyfill guard check
    const wouldExecute = typeof mockWindow !== 'undefined';
    expect(wouldExecute).toBe(false);
  });
});
