/**
 * Main entry point for the Dice Wars game
 * This file initializes the game and loads all necessary modules
 *
 * Note: This is a transition module - it avoids conflicting with the legacy
 * scripts while still setting up the ES6 module system for future use.
 */

// Set flag to indicate ES6 modules are loading
window.ES6_LOADING_STARTED = true;

// Log ES6 module loading with timestamps for debugging
/*
 * Import bridge modules to expose ES6 functionality to legacy code
 * Order is important here - we need to make sure all modules are loaded
 * before the game starts
 */
import './bridge/index.js';

console.log(`[${new Date().toISOString()}] ES6 module system loading...`);

console.log(`[${new Date().toISOString()}] Dice Wars ES6 module system loaded successfully!`);
console.log(`%cDiceWars JS - ES6 Edition`, 'font-size:14px;font-weight:bold;color:#42a5f5;');

/*
 * We're not initializing the game from here in the hybrid approach
 * The game will be initialized by the legacy main.js script
 */

// Export modules for reference and future use
export * from './models/index.js';
export * from './ai/index.js';
export * from './utils/config.js';
export { Game } from './Game.js';
