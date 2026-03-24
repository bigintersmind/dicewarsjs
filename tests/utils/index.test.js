/**
 * Tests for utils index module
 */
import * as utils from '../../src/utils/index.js';

describe('Utils Index Module', () => {
  it('should export all utility modules', () => {
    // Config exports
    expect(typeof utils.DEFAULT_CONFIG).toBe('object');
    expect(typeof utils.getConfig).toBe('function');
    expect(typeof utils.updateConfig).toBe('function');
    expect(typeof utils.resetConfig).toBe('function');
    expect(typeof utils.applyConfigToGame).toBe('function');

    // Render exports
    expect(typeof utils.COLORS).toBe('object');
    expect(typeof utils.scaleValue).toBe('function');
    expect(typeof utils.createText).toBe('function');
    expect(typeof utils.createButtonShape).toBe('function');
    expect(typeof utils.createButton).toBe('function');

    // Sound exports
    expect(typeof utils.SOUND_MANIFEST).toBe('object');
    expect(typeof utils.initSoundSystem).toBe('function');
    expect(typeof utils.playSound).toBe('function');
    expect(typeof utils.stopSound).toBe('function');
    expect(typeof utils.stopAllSounds).toBe('function');
    expect(typeof utils.setVolume).toBe('function');
    expect(typeof utils.setSoundEnabled).toBe('function');

    // Game utils exports
    expect(typeof utils.calculateAttackProbability).toBe('function');
    expect(typeof utils.rollDice).toBe('function');
    expect(typeof utils.simulateAttack).toBe('function');
  });
});
