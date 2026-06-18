#!/usr/bin/env node

/**
 * Bot Scaffolding Tool
 *
 * Creates a new bot file from a template.
 *
 * Usage:
 *   npm run new-bot -- my                          # from random template
 *   npm run new-bot -- my --template greedy        # from greedy template
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getArg, getPositionalArg, toTitleCase, colors } from './lib/cli-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botsDir = path.resolve(__dirname, '..', 'bots');
const TEMPLATES = ['random', 'greedy', 'cautious', 'strategic'];

const args = process.argv.slice(2);
const name = getPositionalArg(args);
const template = getArg(args, 'template', 'random');

// --- Validate inputs ---

if (!name) {
  console.error('Usage: npm run new-bot -- <name> [--template random|greedy|cautious|strategic]');
  console.error('\nExamples:');
  console.error('  npm run new-bot -- my');
  console.error('  npm run new-bot -- my --template strategic');
  process.exit(1);
}

if (!/^[a-z0-9-]+$/.test(name)) {
  console.error(`Invalid bot name: "${name}". Use only lowercase letters, numbers, and hyphens.`);
  process.exit(1);
}

if (!TEMPLATES.includes(template)) {
  console.error(`Unknown template: "${template}". Available: ${TEMPLATES.join(', ')}`);
  process.exit(1);
}

const outputFile = path.join(botsDir, `${name}-bot.js`);

if (fs.existsSync(outputFile)) {
  console.error(`File already exists: ${path.relative(process.cwd(), outputFile)}`);
  console.error('Choose a different name or delete the existing file.');
  process.exit(1);
}

// --- Read template and transform ---

const templateFile = path.join(botsDir, `${template}-bot.js`);

if (!fs.existsSync(templateFile)) {
  console.error(`Template file not found: ${templateFile}`);
  console.error('Make sure you are running from the project root.');
  process.exit(1);
}

let templateSource;
try {
  templateSource = fs.readFileSync(templateFile, 'utf-8');
} catch (err) {
  console.error(`Failed to read template file: ${templateFile}`);
  console.error(`  ${err.message}`);
  process.exit(1);
}
const titleName = toTitleCase(name);

// Replace first JSDoc description line with new bot name
const transformed = templateSource.replace(
  /^\/\*\*\n \* .+ —[^\n]*/,
  `/**\n * ${titleName} Bot — based on ${template} template.`
);

try {
  fs.writeFileSync(outputFile, transformed, 'utf-8');
} catch (err) {
  console.error(`Failed to write bot file: ${path.relative(process.cwd(), outputFile)}`);
  console.error(`  ${err.message}`);
  process.exit(1);
}

const relPath = path.relative(process.cwd(), outputFile);
console.log(`${colors.green}Created${colors.reset} ${relPath}`);
console.log();
console.log('Next steps:');
console.log(`  1. Edit ${relPath} to customize your strategy`);
console.log(`  2. npm run validate-bot -- ${relPath}`);
console.log(`  3. npm run benchmark-bot -- ${relPath}`);
console.log('  4. npm run arena');
