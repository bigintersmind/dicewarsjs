const fs = require('fs');
const path = require('path');

const statsPath = path.join(__dirname, '..', 'dist', 'bundle-stats.json');
const MAX_BUNDLE_SIZE = 250 * 1024; // 250 KB limit

if (!fs.existsSync(statsPath)) {
  console.error('Bundle stats file not found. Run "npm run build:analyze" first.');
  process.exit(1);
}

const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
const jsSize = stats.assets
  .filter(asset => asset.name.endsWith('.js'))
  .reduce((sum, asset) => sum + asset.size, 0);

console.log(`Total JS bundle size: ${(jsSize / 1024).toFixed(2)} KB`);

if (jsSize > MAX_BUNDLE_SIZE) {
  console.error(`Bundle size exceeds limit of ${MAX_BUNDLE_SIZE / 1024} KB`);
  process.exit(1);
}

console.log('Bundle size within acceptable limit.');
