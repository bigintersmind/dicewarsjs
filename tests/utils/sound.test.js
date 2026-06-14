// @vitest-environment jsdom
/**
 * Tests for Sound Utilities Module
 */
import {
  SOUND_MANIFEST,
  initSoundSystem,
  playSound,
  stopSound,
  stopAllSounds,
  setVolume,
  setSoundEnabled,
  toggleSound,
  loadSound,
  loadedSounds,
} from '../../src/utils/sound.js';

// Mock the config module
vi.mock('../../src/utils/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({ soundEnabled: true }),
  updateConfig: vi.fn(),
}));

import { getConfig, updateConfig } from '../../src/utils/config.js';

// Mock the soundStrategy module
vi.mock('../../src/utils/soundStrategy.js', () => ({
  updateLoadStatus: vi.fn(),
}));

describe('Sound Utilities', () => {
  // Setup global createjs mock
  global.createjs = {
    Sound: {
      PLAY_SUCCEEDED: 'succeeded',
      INTERRUPT_ANY: 'interrupt',
      _initializeDefaultPluginsWasCalled: false,
      play: vi.fn(),
      stop: vi.fn(),
      initializeDefaultPlugins: vi.fn().mockReturnValue(true),
      registerSound: vi.fn().mockReturnValue(true),
      registerSounds: vi.fn().mockReturnValue(true),
      registerPlugins: vi.fn(),
      activePlugin: {
        capabilities: {
          formats: ['wav'],
        },
      },
    },
    WebAudioPlugin: {},
    HTMLAudioPlugin: {},
  };

  // Spy on createjs.Sound methods
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the SOUND_MANIFEST and loadedSounds cache before each test
    while (SOUND_MANIFEST.length > 0) {
      SOUND_MANIFEST.pop();
    }
    loadedSounds.clear();

    // Setup default mock returns
    createjs.Sound.play.mockReturnValue({
      on: vi.fn(),
      volume: 1,
      playState: createjs.Sound.PLAY_SUCCEEDED,
    });
  });

  describe('SOUND_MANIFEST', () => {
    beforeEach(() => {
      // Pre-populate SOUND_MANIFEST for this test
      const soundFiles = {
        snd_button: './sound/button.wav',
        snd_clear: './sound/clear.wav',
        snd_click: './sound/click.wav',
        snd_dice: './sound/dice.wav',
        snd_fail: './sound/fail.wav',
        snd_myturn: './sound/myturn.wav',
        snd_over: './sound/over.wav',
        snd_success: './sound/success.wav',
      };

      // Populate the manifest like initSoundSystem does
      for (const [soundId, soundPath] of Object.entries(soundFiles)) {
        SOUND_MANIFEST.push({
          id: soundId,
          src: soundPath,
          type: 'wav',
        });
      }
    });

    test('contains the correct sound files', () => {
      expect(SOUND_MANIFEST.length).toBe(8);
      expect(SOUND_MANIFEST.find(s => s.id === 'snd_button')).toBeTruthy();
      expect(SOUND_MANIFEST.find(s => s.id === 'snd_dice')).toBeTruthy();
    });
  });

  describe('initSoundSystem', () => {
    test('initializes the sound system', () => {
      expect(initSoundSystem()).toBe(true);
      expect(createjs.Sound.initializeDefaultPlugins).toHaveBeenCalled();
      /*
       * We don't use registerSounds anymore, we register each sound individually
       * So we shouldn't test for registerSounds
       */
    });

    test('returns false if sound system cannot be initialized', () => {
      // Mock as if window.createjs is undefined temporarily
      const originalCreatejs = global.createjs;
      delete global.createjs;

      expect(initSoundSystem()).toBe(false);

      // Restore createjs
      global.createjs = originalCreatejs;
    });
  });

  describe('playSound', () => {
    test('plays a sound with default options', async () => {
      const instance = {
        on: vi.fn(),
        volume: 1,
        loop: 0,
        interrupt: 'interrupt',
        playState: createjs.Sound.PLAY_SUCCEEDED,
      };
      createjs.Sound.play.mockReturnValueOnce(instance);

      const result = await playSound('snd_button');

      expect(createjs.Sound.play).toHaveBeenCalledWith('snd_button');
      expect(result).toBeTruthy();
    });

    test('plays a sound with custom options', async () => {
      const options = {
        volume: 0.5,
        loop: 2,
        onComplete: vi.fn(),
      };

      const instance = {
        on: vi.fn(),
        volume: 1,
        loop: 0,
        interrupt: 'interrupt',
        playState: createjs.Sound.PLAY_SUCCEEDED,
      };
      createjs.Sound.play.mockReturnValueOnce(instance);

      const result = await playSound('snd_button', options);

      expect(createjs.Sound.play).toHaveBeenCalledWith('snd_button');
      expect(instance.volume).toBe(0.5);
      expect(instance.loop).toBe(2);
      expect(instance.on).toHaveBeenCalledWith('complete', options.onComplete);
      expect(result).toBe(instance);
    });

    test('returns null if sound is disabled', async () => {
      // Mock getConfig to return soundEnabled: false
      getConfig.mockReturnValueOnce({ soundEnabled: false });

      const result = await playSound('snd_button');
      expect(createjs.Sound.play).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe('stopSound', () => {
    test('stops a specific sound', () => {
      stopSound('snd_button');
      expect(createjs.Sound.stop).toHaveBeenCalledWith('snd_button');
    });
  });

  describe('stopAllSounds', () => {
    test('stops all sounds', () => {
      stopAllSounds();
      expect(createjs.Sound.stop).toHaveBeenCalled();
    });
  });
  describe('volume and enable/disable', () => {
    test('setVolume clamps values between 0 and 1 and updates instances', async () => {
      const instance = {
        on: vi.fn(),
        volume: 1,
        loop: 0,
        interrupt: 'interrupt',
        playState: createjs.Sound.PLAY_SUCCEEDED,
      };
      createjs.Sound.play.mockReturnValueOnce(instance);
      await playSound('snd_button');

      setVolume(2);
      expect(createjs.Sound.volume).toBe(1);
      expect(instance.volume).toBe(1);

      setVolume(-0.5);
      expect(createjs.Sound.volume).toBe(0);
      expect(instance.volume).toBe(0);
    });

    test('setSoundEnabled(false) stops all sounds and toggles the flag', () => {
      getConfig.mockReturnValueOnce({ soundEnabled: true });

      // Spy on stopSound which should be called by stopAllSounds
      const stopSpy = vi.spyOn(createjs.Sound, 'stop').mockClear();

      const previous = setSoundEnabled(false);

      expect(previous).toBe(true);
      expect(updateConfig).toHaveBeenCalledWith({ soundEnabled: false });
      expect(stopSpy).toHaveBeenCalled();
    });
  });
});
