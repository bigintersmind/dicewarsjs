/**
 * Sound Manager
 *
 * Web Audio API-based sound system, replacing CreateJS SoundJS.
 * Lazy-initializes AudioContext on first user interaction to comply
 * with browser autoplay policies.
 *
 * @module audio/SoundManager
 */

const SOUND_PATHS = {
  button: '/sound/button.wav',
  clear: '/sound/clear.wav',
  click: '/sound/click.wav',
  dice: '/sound/dice.wav',
  fail: '/sound/fail.wav',
  myturn: '/sound/myturn.wav',
  over: '/sound/over.wav',
  success: '/sound/success.wav',
};

/**
 * Create a sound manager instance.
 *
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - Initial enabled state
 * @param {number} [options.volume=0.5] - Initial volume (0-1)
 * @returns {{ play, load, loadAll, setVolume, setEnabled, isEnabled, stopAll, destroy }}
 */
export function createSoundManager(options = {}) {
  let enabled = options.enabled !== false;
  let volume = options.volume ?? 0.5;

  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {GainNode | null} */
  let masterGain = null;
  /** @type {Map<string, AudioBuffer>} */
  const buffers = new Map();
  /** @type {Set<AudioBufferSourceNode>} */
  const activeSources = new Set();
  /** @type {Map<string, Promise<AudioBuffer>>} */
  const loadingPromises = new Map();

  /** Lazily create AudioContext (must be called from a user gesture). */
  function ensureContext() {
    if (ctx) return ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(ctx.destination);
    } catch (err) {
      console.warn('[SoundManager] Failed to create AudioContext:', err.message);
      ctx = null;
    }
    return ctx;
  }

  /**
   * Load a single sound by ID.
   * @param {string} soundId - Key from SOUND_PATHS
   * @returns {Promise<AudioBuffer | null>}
   */
  async function load(soundId) {
    if (buffers.has(soundId)) return buffers.get(soundId);
    if (loadingPromises.has(soundId)) return loadingPromises.get(soundId);

    const path = SOUND_PATHS[soundId];
    if (!path) return null;

    const promise = (async () => {
      try {
        const audioCtx = ensureContext();
        if (!audioCtx) return null;

        const response = await fetch(path);
        if (!response.ok) {
          console.warn(`[SoundManager] Failed to load "${soundId}": HTTP ${response.status}`);
          return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        buffers.set(soundId, audioBuffer);
        return audioBuffer;
      } catch (err) {
        console.warn(`[SoundManager] Error loading "${soundId}":`, err.message);
        return null;
      } finally {
        loadingPromises.delete(soundId);
      }
    })();

    loadingPromises.set(soundId, promise);
    return promise;
  }

  /** Load all sounds. Returns when all are loaded. */
  async function loadAll() {
    await Promise.all(Object.keys(SOUND_PATHS).map(id => load(id)));
  }

  /**
   * Play a sound.
   * @param {string} soundId
   */
  function play(soundId) {
    if (!enabled) return;

    const audioCtx = ensureContext();
    if (!audioCtx || !masterGain) return;

    // Resume context if suspended (autoplay policy)
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const buffer = buffers.get(soundId);
    if (!buffer) {
      // Try loading on demand
      load(soundId)
        .then(() => {
          const buf = buffers.get(soundId);
          if (buf && enabled) playBuffer(buf);
        })
        .catch(err => {
          console.warn(`[SoundManager] On-demand load failed for "${soundId}":`, err.message);
        });
      return;
    }

    playBuffer(buffer);
  }

  /** @param {AudioBuffer} buffer */
  function playBuffer(buffer) {
    if (!ctx || !masterGain) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(masterGain);
    source.onended = () => activeSources.delete(source);
    activeSources.add(source);
    source.start(0);
  }

  /**
   * Set master volume.
   * @param {number} v - Volume 0-1
   */
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (masterGain) {
      masterGain.gain.value = volume;
    }
  }

  /**
   * Enable or disable all sound.
   * @param {boolean} on
   */
  function setEnabled(on) {
    enabled = Boolean(on);
    if (!enabled) stopAll();
  }

  /** @returns {boolean} */
  function isEnabled() {
    return enabled;
  }

  /** Stop all currently playing sounds. */
  function stopAll() {
    for (const source of activeSources) {
      try {
        source.stop();
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'InvalidStateError')) {
          console.warn('[SoundManager] Unexpected error stopping source:', err);
        }
      }
    }
    activeSources.clear();
  }

  /** Clean up. */
  function destroy() {
    stopAll();
    if (ctx) {
      ctx.close().catch(err => {
        console.warn('[SoundManager] Error closing AudioContext:', err.message);
      });
      ctx = null;
    }
    buffers.clear();
  }

  return {
    play,
    load,
    loadAll,
    setVolume,
    setEnabled,
    isEnabled,
    stopAll,
    destroy,
  };
}
