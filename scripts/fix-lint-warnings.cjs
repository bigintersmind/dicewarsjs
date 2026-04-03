#!/usr/bin/env node

/**
 * Script to automatically fix common ESLint warnings
 *
 * This script helps reduce the number of common warnings like:
 * - Unused imports
 * - Unused variables
 * - Missing return types in JSDoc
 *
 * Usage:
 *   npm run fix-warnings
 */

const { execSync } = require('child_process');

// ANSI color codes for output
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Log with colors
const log = {
  info: msg => console.log(`${COLORS.blue}[INFO]${COLORS.reset} ${msg}`),
  success: msg => console.log(`${COLORS.green}[SUCCESS]${COLORS.reset} ${msg}`),
  warning: msg => console.log(`${COLORS.yellow}[WARNING]${COLORS.reset} ${msg}`),
  error: msg => console.log(`${COLORS.red}[ERROR]${COLORS.reset} ${msg}`),
  section: msg => console.log(`\n${COLORS.cyan}=== ${msg} ===${COLORS.reset}`),
};

// Run a command and return its output
function runCommand(command) {
  try {
    log.info(`Running: ${command}`);
    return execSync(command, { encoding: 'utf8' });
  } catch (error) {
    if (error.stdout) {
      return error.stdout.toString();
    }
    log.error(`Command failed: ${error.message}`);
    return '';
  }
}

// Get all JS files tracked by Git
function getTrackedJsFiles() {
  const output = runCommand('git ls-files "*.js"');
  return output
    .split('\n')
    .filter(Boolean)
    .filter(file => !file.startsWith('node_modules/') && !file.startsWith('dist/'));
}

// Get list of unused variables from ESLint output
function getUnusedVariables(files) {
  log.section('Analyzing unused variables');

  const eslintOutput = runCommand(`npx eslint ${files.join(' ')} --format json`);
  let results;

  try {
    results = JSON.parse(eslintOutput);
  } catch (e) {
    log.error('Failed to parse ESLint output as JSON');
    return [];
  }

  const unusedVarsMap = new Map();

  results.forEach(result => {
    const filePath = result.filePath;

    result.messages
      .filter(msg => msg.ruleId === 'no-unused-vars')
      .forEach(msg => {
        if (!unusedVarsMap.has(filePath)) {
          unusedVarsMap.set(filePath, []);
        }

        unusedVarsMap.get(filePath).push({
          name: msg.message.match(/'([^']+)'/)[1],
          line: msg.line,
          column: msg.column,
        });
      });
  });

  return unusedVarsMap;
}

// Auto-fix issues where possible
function autoFixIssues(files) {
  log.section('Auto-fixing issues');

  // First run ESLint with --fix
  runCommand(`npx eslint ${files.join(' ')} --fix`);
  log.info('Applied automated ESLint fixes');

  // Then run Prettier
  runCommand(`npx prettier --write ${files.join(' ')}`);
  log.info('Applied Prettier formatting');

  // Get unused variables that couldn't be auto-fixed
  const unusedVarsMap = getUnusedVariables(files);

  if (unusedVarsMap.size === 0) {
    log.success('No remaining unused variables detected!');
    return;
  }

  log.warning(
    `Found ${Array.from(unusedVarsMap.values()).flat().length} unused variables that need manual attention:`
  );

  // Print report of remaining issues
  for (const [filePath, variables] of unusedVarsMap.entries()) {
    log.info(`\nFile: ${filePath}`);
    variables.forEach(v => {
      console.log(`  Line ${v.line}: '${v.name}'`);
    });
  }

  // Suggest prefixing with underscore
  log.info('\nTip: You can prefix unused variables with an underscore to suppress warnings:');
  log.info('  Original: function example(unused, param) { ... }');
  log.info('  Fixed:    function example(_unused, param) { ... }');
}

// Main function
function main() {
  log.section('Lint Warning Auto-Fix Script');

  const files = getTrackedJsFiles();
  log.info(`Found ${files.length} JavaScript files to process`);

  autoFixIssues(files);

  // Run final lint check to see how we did
  log.section('Final Lint Check');
  runCommand('npm run lint');
  log.info('Done!');
}

main();
