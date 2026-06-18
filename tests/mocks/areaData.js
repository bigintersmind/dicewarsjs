/**
 * Minimal AreaData stand-in for AI tests.
 *
 * Mirrors the zero-initialized territory record that the legacy
 * src/models/AreaData.js exposed. Lives under tests/ so the AI mocks no longer
 * depend on the (now removed) src/models cluster — the engine uses plain
 * objects, so this shape is only needed by the legacy-interface AI tests.
 */
export class AreaData {
  constructor() {
    this.size = 0; // Size of area (0 = not present, >0 = number of cells)
    this.cpos = 0; // Center cell position
    this.arm = 0; // Player/army affiliation
    this.dice = 0; // Number of dice in this territory

    // Bounding box
    this.left = 0;
    this.right = 0;
    this.top = 0;
    this.bottom = 0;
    this.cx = 0;
    this.cy = 0;
    this.len_min = 0;

    // Border drawing information
    this.line_cel = new Array(100);
    this.line_dir = new Array(100);

    // Adjacency: indices of areas sharing a border with this one
    this.join = Array(32).fill(0);
  }
}
