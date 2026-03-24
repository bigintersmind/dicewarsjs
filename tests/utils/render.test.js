/**
 * Tests for Rendering Utilities Module
 */
import {
  COLORS,
  scaleValue,
  createText,
  createButtonShape,
  createButton,
} from '../../src/utils/render.js';

// Mock the config module
vi.mock('../../src/utils/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({ displayScale: 2 }),
}));

describe('Rendering Utilities', () => {
  describe('COLORS', () => {
    test('has the correct player colors', () => {
      expect(COLORS.PLAYER.length).toBe(8);
      expect(COLORS.PLAYER[0]).toBe('#9966FF'); // Purple (Human Player)
    });

    test('has the correct territory colors', () => {
      expect(COLORS.TERRITORY.BORDER).toBe('#000000');
      expect(COLORS.TERRITORY.HIGHLIGHT_ATTACK).toBe('#FF0000');
      expect(COLORS.TERRITORY.HIGHLIGHT_TARGET).toBe('#0000FF');
    });
  });

  describe('scaleValue', () => {
    test('scales value by display scale factor', () => {
      // Display scale is mocked to 2
      expect(scaleValue(10)).toBe(20);
      expect(scaleValue(5.5)).toBe(11);
    });
  });

  describe('createText', () => {
    test('creates a createjs.Text object with correct properties', () => {
      const text = createText('Hello', 10, 20, '#FF0000', '16px Arial', 'left');

      expect(text).toBeInstanceOf(createjs.Text);
      expect(text.text).toBe('Hello');
      expect(text.color).toBe('#FF0000');
      expect(text.font).toBe('16px Arial');
      expect(text.textAlign).toBe('left');
      expect(text.textBaseline).toBe('middle');
      expect(text.x).toBe(20); // 10 * scale factor 2
      expect(text.y).toBe(40); // 20 * scale factor 2
    });

    test('uses default values when optional parameters are omitted', () => {
      const text = createText('Hello', 10, 20);

      expect(text.color).toBe('#000000');
      expect(text.font).toBe('20px Arial');
      expect(text.textAlign).toBe('center');
    });
  });

  describe('createButtonShape', () => {
    test('creates a createjs.Shape object with correct properties', () => {
      const button = createButtonShape(10, 20, 100, 50, '#AABBCC', 8);

      expect(button).toBeInstanceOf(createjs.Shape);
      expect(button.x).toBe(20); // 10 * scale factor 2
      expect(button.y).toBe(40); // 20 * scale factor 2
    });

    test('uses default values when optional parameters are omitted', () => {
      const button = createButtonShape(10, 20, 100, 50);

      // We'd need a more sophisticated mock to test the graphics calls
      expect(button.x).toBe(20);
      expect(button.y).toBe(40);
    });
  });

  describe('createButton', () => {
    test('creates a createjs.Container with a button shape and text', () => {
      const clickHandler = vi.fn();
      const button = createButton('Click Me', 10, 20, 100, 50, clickHandler);

      expect(button).toBeInstanceOf(createjs.Container);
      expect(button.x).toBe(20); // 10 * scale factor 2
      expect(button.y).toBe(40); // 20 * scale factor 2
      expect(button.children.length).toBe(2);

      // First child should be shape, second should be text
      expect(button.children[0]).toBeInstanceOf(createjs.Shape);
      expect(button.children[1]).toBeInstanceOf(createjs.Text);
      expect(button.children[1].text).toBe('Click Me');
    });
  });
});
