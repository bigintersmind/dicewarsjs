# Bridge Initialization Pattern

This document describes the robust initialization pattern implemented to prevent timing issues between ES6 modules and legacy code.

## Problem

The previous bridge implementation had several timing issues:

1. **Async Loading**: AI modules loaded asynchronously, causing race conditions
2. **No Synchronization**: Legacy code couldn't know when ES6 modules were ready
3. **Silent Failures**: Errors during initialization weren't properly handled
4. **No Fallbacks**: If modules failed to load, the game would break

## Solution

### 1. Initialization Module (`src/bridge/initialization.js`)

Central coordination point that:

- Tracks initialization status of each module
- Provides promises for async waiting
- Dispatches events when ready
- Implements timeout detection
- Handles errors gracefully

### 2. Placeholder Pattern

AI functions are immediately available as placeholders:

```javascript
// Synchronous - available immediately
window.ai_default = createPlaceholder('ai_default');

// Placeholder returns safe default (ends turn)
// Real implementation loaded async and swapped in
```

### 3. Module Callbacks

Each module signals when ready:

```javascript
// In ai.js after loading
initCallbacks.aiReady();

// Or with error
initCallbacks.aiReady(error);
```

## Usage

### From Legacy Code

#### Method 1: Promise-based (Recommended)

```javascript
// In main.js or other legacy code
async function initGame() {
  // Wait for bridge to be ready
  const result = await window.waitForBridge();

  if (result.success) {
    // All modules loaded successfully
    startGame();
  } else {
    // Check which modules failed
    console.error('Bridge initialization failed:', result.status);
    // Game can still start with fallbacks
    startGame();
  }
}
```

#### Method 2: Event-based

```javascript
// Listen for ready event
window.addEventListener('es6BridgeReady', event => {
  const { status, hasErrors } = event.detail;

  if (!hasErrors) {
    console.log('Bridge ready, starting game');
    startGame();
  }
});

// Legacy compatibility event
window.addEventListener('es6ModulesLoaded', () => {
  console.log('ES6 modules loaded (legacy event)');
});
```

#### Method 3: Polling (Not Recommended)

```javascript
function checkBridgeReady() {
  if (window.ES6_BRIDGE_READY) {
    startGame();
  } else {
    setTimeout(checkBridgeReady, 100);
  }
}
```

### From ES6 Modules

```javascript
import { BridgeInitializer } from '@bridge/index.js';

// Check if ready
if (BridgeInitializer.isReady()) {
  // Use immediately
} else {
  // Wait for ready
  await BridgeInitializer.whenReady();
}

// Get status
const status = BridgeInitializer.getStatus();
console.log('Module status:', status);
```

## API Reference

### Global Functions

- `window.waitForBridge()` - Returns promise that resolves when ready
- `window.checkBridgeStatus()` - Returns current status object
- `window.verifyES6BridgeStatus()` - Detailed status with AI function states

### BridgeInitializer Methods

- `whenReady()` - Promise that resolves when all modules ready
- `isReady()` - Boolean check for immediate status
- `getStatus()` - Detailed status of each module
- `recheck()` - Force status recheck
- `reset()` - Reset initialization (testing only)

### Events

- `es6BridgeReady` - Fired when bridge initialization completes
  - `event.detail.status` - Module status object
  - `event.detail.hasErrors` - Boolean indicating if any errors
- `es6ModulesLoaded` - Legacy compatibility event

## Error Handling

### Timeout Protection

```javascript
// 5-second timeout automatically marks uninitialized modules as failed
setTimeout(() => {
  if (!bridgeInitialized) {
    // Force completion with timeout errors
  }
}, 5000);
```

### Fallback AI Functions

```javascript
// If AI fails to load, safe fallback is used
const fallbackAI = game => {
  console.warn('Using fallback AI - ending turn');
  return 0; // End turn
};
```

### Error Recovery

```javascript
// Even if modules fail, game can continue
const result = await waitForBridge();
if (!result.success) {
  console.warn('Some modules failed, using fallbacks');
  // Game still playable with reduced functionality
}
```

## Benefits

1. **Prevents Race Conditions**: Synchronization ensures proper load order
2. **Graceful Degradation**: Fallbacks keep game playable
3. **Better Debugging**: Clear status reporting and error messages
4. **Flexible Integration**: Multiple ways to check readiness
5. **Timeout Protection**: Won't hang indefinitely
6. **Backward Compatible**: Works with existing legacy code

## Migration Guide

To update legacy code to use this pattern:

1. **Replace direct AI access** with initialization check:

```javascript
// Old
game.ai[currentPlayer](game);

// New
if (window.ES6_BRIDGE_READY) {
  game.ai[currentPlayer](game);
} else {
  // Use fallback or wait
}
```

2. **Add initialization wait** to game start:

```javascript
// In window.onload or init function
window.addEventListener('load', async () => {
  await window.waitForBridge();
  init(); // Original initialization
});
```

3. **Check AI function status** before use:

```javascript
const status = window.verifyES6BridgeStatus();
if (status.aiStatus.ai_default === 'Loaded') {
  // Safe to use
}
```

## Testing

The initialization system can be tested by:

1. **Simulating Slow Loading**:

```javascript
// In AI module loader
await new Promise(resolve => setTimeout(resolve, 2000));
```

2. **Forcing Errors**:

```javascript
// In module initialization
throw new Error('Test initialization failure');
```

3. **Checking Timeout**:

```javascript
// Don't call initCallbacks.aiReady()
// System should timeout after 5 seconds
```

This robust pattern ensures the bridge between legacy and ES6 code is reliable and predictable.
