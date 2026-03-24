/**
 * Main.js - Entry point for the Dice Wars game
 * 
 * Handles initialization, rendering, and UI interactions
 */
import { Game } from './Game.js';
import { renderTitleScreen } from './ui/titleScreen.js';

// Global variables
let canvas, stage;        // CreateJS canvas and stage objects
let builder;              // CreateJS SpriteSheetBuilder for dice graphics
let touchdev = false;     // Flag indicating touch device detection

// Event handler functions - set dynamically based on game state
let timer_func = null;    // Called on each tick
let click_func = null;    // Called on mouse down
let move_func = null;     // Called on mouse move
let release_func = null;  // Called on mouse up
let waitcount = 0;        // Counter for timing/animation delays
let stat = 0;             // General state variable used in state machines

// Main game object - contains all game logic and state
const game = new Game();

// Import and apply configuration
import { applyConfigToGame, loadConfig } from './utils/config.js';
const config = loadConfig();
(async () => {
  await applyConfigToGame(game, config);
  if (typeof window !== 'undefined' && typeof window.applyGameConfig === 'function') {
    window.applyGameConfig(game);
  }
})();

// Display position and scaling parameters
const original_config = {
    view_w: 840,
    view_h: 840,
    cel_w: 27,
    cel_h: 18,
    ypos_mes: 688,
    ypos_arm: 770
};  // Original size configuration

let scale_numerator = 1;        // Numerator for scaling ratio (scales up)
let scale_denominator = 1;      // Denominator for scaling ratio (scales down)
let view_w, view_h;             // Actual display dimensions after scaling
let cell_w, cell_h;             // Cell size after scaling (hexagonal grid cells)
let ypos_message;               // Y-position for messages and battle dice display
let ypos_army_status;           // Y-position for player status indicators
let dot_size;                   // Size of 1 dot after scaling (for line thickness)

// Arrays storing the pixel positions of each hexagonal cell
const cell_pos_x = [];  // X-coordinates of each cell
const cell_pos_y = [];  // Y-coordinates of each cell

// Main array containing all sprite objects
const sprites = [];

// Sprite indices - these are starting indices for different sprite categories
const SPRITE_INDEX = {
    AREA: 0,        // Area shapes (territories)
    FROM: 0,        // Highlight for attacking territory
    TO: 0,          // Highlight for defending territory
    DICE: 0,        // Dice display for each territory
    INFO: 0,        // First sprite index after map elements (UI elements start here)
    BAN: 0,         // Current player indicator
    PLAYER: 0,      // Player status indicators
    BATTLE: 0,      // Battle animation elements
    SUPPLY: 0,      // Reinforcement dice display
    GAMEOVER: 0,    // Game over screen
    WIN: 0,         // Victory screen
    TITLE: 0,       // Title screen
    PMAX: 0,        // Player count selection UI
    LOAD: 0,        // Loading indicator
    MES: 0,         // Message display
    BTN: 0,         // Button sprites
    MAX: 0          // Total number of sprites
};

// Area ordering and mapping arrays
const area_draw_priority = [];   // Display order of area dice (for proper z-ordering)
const area_num_to_sprite_num = []; // Maps area numbers to sprite indices for quick lookup

// Button system variables
let button_max = 0;              // Total number of buttons
let active_button_index = -1;    // Index of currently active button (-1 if none)
const button_functions = [];     // Array of button click handler functions

// Battle animation variables
class Battle {
    constructor() {
        this.dice_number_to_stop = 0;              // Dice number (position to stop)
        this.army_id = 0;                          // Player/army ID for dice color
        this.dice_count = 0;                       // Number of dice in the battle
        this.dice_values = [0, 0, 0, 0, 0, 0, 0, 0];  // Actual values rolled for each die
        this.roll_sum = 0;                         // Total sum of dice values
        this.finished_flags = [0, 0, 0, 0, 0, 0, 0, 0]; // Animation finished flags for each die
        this.dice_indices_to_use = [0, 1, 2, 3, 4, 5, 6, 7]; // Dice indices to use (shuffled for animation)
    }
}
const battle_data = [];        // Array holding Battle instances for attacker and defender
let battle_turn = 0;           // Battle animation turn (0 for attacker, 1 for defender)

// History replay system
let replay_counter = 0;        // Current step in history replay

// Game mode flags
let spectate_mode = false;     // Flag for spectator mode (AI vs AI)

// Sound system
let sound_on = true;           // Flag for sound enabled/disabled
const sound_manifest = [       // Sound file manifest for CreateJS sound system
    {"src":"./sound/button.wav", "id":"snd_button"},  // Button click
    {"src":"./sound/clear.wav",  "id":"snd_clear"},   // Victory sound
    {"src":"./sound/click.wav",  "id":"snd_click"},   // Area selection
    {"src":"./sound/dice.wav",   "id":"snd_dice"},    // Dice roll
    {"src":"./sound/fail.wav",   "id":"snd_fail"},    // Attack failed
    {"src":"./sound/myturn.wav", "id":"snd_myturn"},  // Player turn notification
    {"src":"./sound/over.wav",   "id":"snd_over"},    // Game over
    {"src":"./sound/success.wav","id":"snd_success"}  // Attack succeeded
];

/**
 * Utility function to apply scaling ratio to any number
 * @param {number} n - The number to scale
 * @returns {number} The scaled value
 */
function resize(n) {
    return n * scale_numerator / scale_denominator;
}

/**
 * Initialize the game on window load
 */
function init() {
    // Initialize canvas
    canvas = document.getElementById("myCanvas");
    
    // Setup event listeners
    if (createjs.Touch.isSupported()) {
        createjs.Touch.enable(stage);
        touchdev = true;
    }
    
    // Initialize CreateJS stage
    stage = new createjs.Stage(canvas);
    stage.enableMouseOver();
    
    // Set up update tick
    createjs.Ticker.timingMode = createjs.Ticker.RAF;
    createjs.Ticker.addEventListener("tick", tick);
    
    // Load sounds for desktop browsers
    if (!createjs.Sound.initializeDefaultPlugins()) {
        console.log("Sound not supported in this browser");
    } else {
        createjs.Sound.registerSounds(sound_manifest);
    }
    
    // Set up event listeners
    canvas.addEventListener("mousedown", mouseDownListener);
    canvas.addEventListener("mousemove", mouseMoveListener);
    canvas.addEventListener("mouseup", mouseUpListener);
    
    // Start the title screen
    start_title_screen();
}

/**
 * Main update function - called on every animation frame
 * @param {Event} event - Tick event from CreateJS
 */
function tick(event) {
    // Call the current timer function if set
    if (timer_func !== null) {
        timer_func();
    }
    
    // Update the stage
    stage.update();
}

/**
 * Mouse down event handler - routes to current click handler
 * @param {MouseEvent} e - Mouse event
 */
function mouseDownListener(e) {
    if (click_func !== null) {
        click_func(e);
    }
}

/**
 * Mouse move event handler - routes to current move handler
 * @param {MouseEvent} e - Mouse event
 */
function mouseMoveListener(e) {
    if (move_func !== null) {
        move_func(e);
    }
}

/**
 * Mouse up event handler - routes to current release handler
 * @param {MouseEvent} e - Mouse event
 */
function mouseUpListener(e) {
    if (release_func !== null) {
        release_func(e);
    }
}

/**
 * Initialize the title screen display
 */
function start_title_screen() {
    timer_func = null;
    click_func = null;
    move_func = null;
    release_func = null;

    renderTitleScreen(stage);
}

/**
 * Initialize the game - exported function that serves as the public API
 * This is called by the index.js entry point
 */
export function initGame() {
  init();
}

// Export game instance for testing and debugging
export { game };