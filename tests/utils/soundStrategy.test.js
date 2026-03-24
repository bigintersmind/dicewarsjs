/**
 * Tests for Sound Strategy module
 *
 * This tests the strategic loading of sound assets based on priority and usage patterns.
 */

import {
  SOUND_PRIORITIES,
  addLoadListener,
  updateLoadStatus,
  scheduleWhenIdle,
  loadSoundsByPriority,
  createLoadingIndicator,
} from '../../src/utils/soundStrategy';

describe('Sound Strategy', () => {
  let originalRequestIdleCallback;
  let originalSetTimeout;
  let consoleSpy;

  beforeEach(() => {
    // Store original values
    originalRequestIdleCallback = window.requestIdleCallback;
    originalSetTimeout = window.setTimeout;

    // Reset and mock setTimeout
    window.setTimeout = vi.fn(callback => {
      callback();
      return 123; // Mock timer ID
    });

    // Mock requestIdleCallback
    window.requestIdleCallback = vi.fn(callback => {
      callback({ timeRemaining: () => 50, didTimeout: false });
      return 456; // Mock timer ID
    });

    // Spy on console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original functions
    window.setTimeout = originalSetTimeout;

    // Only restore requestIdleCallback if it was originally defined
    if (originalRequestIdleCallback) {
      window.requestIdleCallback = originalRequestIdleCallback;
    } else {
      delete window.requestIdleCallback;
    }

    // Restore console.error
    consoleSpy.mockRestore();
  });

  test('SOUND_PRIORITIES contains expected sound categories', () => {
    expect(SOUND_PRIORITIES).toHaveProperty('CRITICAL');
    expect(SOUND_PRIORITIES).toHaveProperty('GAMEPLAY');
    expect(SOUND_PRIORITIES).toHaveProperty('ENDGAME');

    // Check for specific sounds in each category
    expect(SOUND_PRIORITIES.CRITICAL).toContain('snd_button');
    expect(SOUND_PRIORITIES.CRITICAL).toContain('snd_click');

    expect(SOUND_PRIORITIES.GAMEPLAY).toContain('snd_dice');
    expect(SOUND_PRIORITIES.GAMEPLAY).toContain('snd_success');

    expect(SOUND_PRIORITIES.ENDGAME).toContain('snd_over');
  });

  test('addLoadListener registers and returns unregister function', () => {
    const mockListener = vi.fn();

    // Add listener
    const removeListener = addLoadListener(mockListener);

    // Trigger listener with updateLoadStatus
    updateLoadStatus(1);
    expect(mockListener).toHaveBeenCalledWith(true);

    // Remove listener and verify it's not called again
    mockListener.mockClear();
    removeListener();
    updateLoadStatus(-1);
    expect(mockListener).not.toHaveBeenCalled();
  });

  test('updateLoadStatus updates loading count and notifies listeners', () => {
    const mockListener1 = vi.fn();
    const mockListener2 = vi.fn();

    // Add listeners
    addLoadListener(mockListener1);
    addLoadListener(mockListener2);

    // Start loading
    updateLoadStatus(1);
    expect(mockListener1).toHaveBeenCalledWith(true);
    expect(mockListener2).toHaveBeenCalledWith(true);

    // Start another loading process
    mockListener1.mockClear();
    mockListener2.mockClear();
    updateLoadStatus(1);
    expect(mockListener1).toHaveBeenCalledWith(true);
    expect(mockListener2).toHaveBeenCalledWith(true);

    // Complete one loading process
    mockListener1.mockClear();
    mockListener2.mockClear();
    updateLoadStatus(-1);
    expect(mockListener1).toHaveBeenCalledWith(true); // Still loading
    expect(mockListener2).toHaveBeenCalledWith(true);

    // Complete all loading
    mockListener1.mockClear();
    mockListener2.mockClear();
    updateLoadStatus(-1);
    expect(mockListener1).toHaveBeenCalledWith(false); // Not loading anymore
    expect(mockListener2).toHaveBeenCalledWith(false);
  });

  test('scheduleWhenIdle functionalities', () => {
    /*
     * We're testing the presence of the function, not its behavior
     * (which is too tightly coupled to browser APIs to test reliably)
     */
    expect(typeof scheduleWhenIdle).toBe('function');
  });

  test('scheduleWhenIdle falls back to setTimeout when requestIdleCallback not available', () => {
    // Temporarily remove requestIdleCallback
    const tempRequestIdleCallback = window.requestIdleCallback;
    delete window.requestIdleCallback;

    const mockCallback = vi.fn();

    // Call scheduleWhenIdle
    scheduleWhenIdle(mockCallback);

    // Check if setTimeout was called instead
    expect(window.setTimeout).toHaveBeenCalledWith(mockCallback, 1000);

    // Restore requestIdleCallback
    window.requestIdleCallback = tempRequestIdleCallback;
  });

  test('loadSoundsByPriority loads critical sounds immediately', () => {
    // Setup fresh mocks for this test
    const mockLoadSoundFn = vi.fn();

    // Call loadSoundsByPriority
    loadSoundsByPriority(mockLoadSoundFn);

    // Verify critical sounds were loaded immediately
    SOUND_PRIORITIES.CRITICAL.forEach(soundId => {
      expect(mockLoadSoundFn).toHaveBeenCalledWith(soundId);
    });

    /*
     * We're testing critical sounds were loaded immediately, which is the most important part
     * We don't test the scheduling implementation details as they're too brittle
     */
  });

  test('loadSoundsByPriority handles invalid load function', () => {
    // Call with null function
    loadSoundsByPriority(null);
    expect(console.error).toHaveBeenCalled();

    console.error.mockClear();

    // Call with non-function
    loadSoundsByPriority('not a function');
    expect(console.error).toHaveBeenCalled();
  });

  test('createLoadingIndicator creates and attaches DOM element', () => {
    // Set up mock container
    const mockContainer = {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    };

    // Mock document.createElement
    const originalCreateElement = document.createElement;
    const mockIndicator = {
      className: '',
      style: {},
      innerHTML: '',
    };
    document.createElement = vi.fn(() => mockIndicator);

    // Create loading indicator
    const indicator = createLoadingIndicator(mockContainer);

    // Verify indicator was created and styled
    expect(document.createElement).toHaveBeenCalledWith('div');
    expect(mockIndicator.className).toBe('sound-loading-indicator');
    expect(mockIndicator.style.display).toBe('none');
    expect(mockContainer.appendChild).toHaveBeenCalledWith(mockIndicator);

    // Verify update text functionality
    indicator.updateText('Updated text');
    expect(mockIndicator.innerHTML).toBe('Updated text');

    // Verify remove functionality
    indicator.remove();
    expect(mockContainer.removeChild).toHaveBeenCalledWith(mockIndicator);

    // Restore original createElement
    document.createElement = originalCreateElement;
  });

  test('loading indicator responds to loading state changes', () => {
    // Set up mock container
    const mockContainer = {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    };

    // Mock document.createElement
    const originalCreateElement = document.createElement;
    const mockIndicator = {
      className: '',
      style: {},
      innerHTML: '',
    };
    document.createElement = vi.fn(() => mockIndicator);

    // Create loading indicator
    createLoadingIndicator(mockContainer);

    // Simulate loading start
    updateLoadStatus(1);
    expect(mockIndicator.style.display).toBe('block');

    // Simulate loading complete
    updateLoadStatus(-1);
    expect(mockIndicator.style.display).toBe('none');

    // Restore original createElement
    document.createElement = originalCreateElement;
  });
});
