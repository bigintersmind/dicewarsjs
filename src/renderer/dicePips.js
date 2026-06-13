/**
 * Dice Pip Layout
 *
 * Shared pip (dot) position patterns for die faces, used by both the
 * on-map dice stacks (DiceRenderer) and the battle dice (BattleAnimation).
 *
 * @module renderer/dicePips
 */

/**
 * Pip offsets for die values 1-6 on a unit grid.
 * Each entry is [x, y] with components in {-1, 0, 1}, scaled by spacing.
 */
const PIP_LAYOUTS = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};

/**
 * Get pip positions for a die value, scaled by spacing.
 * Unknown values fall back to a single centered pip.
 *
 * @param {number} value - Die face value (1-6)
 * @param {number} spacing - Distance from the face center to the outer pips
 * @returns {Array<[number, number]>} Pip [x, y] offsets from the face center
 */
export function getPipPositions(value, spacing) {
  const layout = PIP_LAYOUTS[value] || PIP_LAYOUTS[1];
  return layout.map(([px, py]) => [px * spacing, py * spacing]);
}
