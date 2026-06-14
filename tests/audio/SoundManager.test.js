// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSoundManager } from '../../src/audio/SoundManager.js';

// Mock Web Audio API
function createMockAudioContext() {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
  };

  const sourceNode = {
    buffer: null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  };

  const ctx = {
    state: 'running',
    createGain: vi.fn(() => gainNode),
    createBufferSource: vi.fn(() => ({ ...sourceNode })),
    decodeAudioData: vi.fn(async buf => buf),
    resume: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    destination: {},
    _gainNode: gainNode,
  };

  return ctx;
}

describe('SoundManager', () => {
  let mockCtx;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
    global.AudioContext = vi.fn(() => mockCtx);
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(100),
    }));
  });

  it('creates with default options', () => {
    const sm = createSoundManager();
    expect(sm.isEnabled()).toBe(true);
  });

  it('creates with custom options', () => {
    const sm = createSoundManager({ enabled: false, volume: 0.3 });
    expect(sm.isEnabled()).toBe(false);
  });

  it('setEnabled toggles sound', () => {
    const sm = createSoundManager();
    sm.setEnabled(false);
    expect(sm.isEnabled()).toBe(false);
    sm.setEnabled(true);
    expect(sm.isEnabled()).toBe(true);
  });

  it('load fetches and decodes a sound', async () => {
    const sm = createSoundManager();
    // Trigger context creation
    sm.play('click');
    const buffer = await sm.load('click');
    expect(global.fetch).toHaveBeenCalled();
    expect(buffer).toBeTruthy();
  });

  it('load returns null for unknown sound ID', async () => {
    const sm = createSoundManager();
    sm.play('click'); // ensure context
    const buffer = await sm.load('nonexistent');
    expect(buffer).toBeNull();
  });

  it('play does nothing when disabled', () => {
    const sm = createSoundManager({ enabled: false });
    sm.play('click');
    // AudioContext should not be created
    expect(global.AudioContext).not.toHaveBeenCalled();
  });

  it('setVolume clamps to 0-1', () => {
    const sm = createSoundManager();
    sm.play('click'); // ensure context
    sm.setVolume(1.5);
    expect(mockCtx._gainNode.gain.value).toBe(1);
    sm.setVolume(-0.5);
    expect(mockCtx._gainNode.gain.value).toBe(0);
    sm.setVolume(0.7);
    expect(mockCtx._gainNode.gain.value).toBe(0.7);
  });

  it('stopAll stops active sources', () => {
    const sm = createSoundManager();
    sm.play('click'); // ensure context
    sm.stopAll();
    // No error thrown
  });

  it('destroy closes the context', () => {
    const sm = createSoundManager();
    sm.play('click'); // ensure context
    sm.destroy();
    expect(mockCtx.close).toHaveBeenCalled();
  });

  it('loadAll loads all sounds', async () => {
    const sm = createSoundManager();
    sm.play('click'); // ensure context
    await sm.loadAll();
    // 8 sounds should be fetched
    expect(global.fetch).toHaveBeenCalledTimes(8);
  });
});
