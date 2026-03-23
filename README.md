# Dicewars JS

This is a modern, enhanced version of [Dice Wars](https://www.gamedesign.jp/games/dicewars/), a strategic dice-based territory conquest game. The project builds upon:

👉 [**Play the game online**](https://bigintersmind.github.io/dicewarsjs/) 👈

1. The original game from [gamedesign.jp](https://www.gamedesign.jp/games/dicewars/)
2. [Chris Raff's modification](https://github.com/chrisraff/dicewarsjs) that added custom AI capabilities

This fork significantly extends the project with:

- Modern JavaScript practices (ES6+ modules, webpack)
- Improved architecture and code organization
- Enhanced gameplay features and UI improvements
- Comprehensive documentation for players and developers
- Developer tooling and quality assurance

The project is undergoing a major modernization. See the [Modernization Roadmap](docs/MODERNIZATION_ROADMAP.md) for the full plan, including a move to PixiJS rendering, a Bot SDK for community-built AI, and an arena system for bot competitions.

## Features

- Multiple AI players with different strategies
- Spectator mode to watch AI players compete
- Configurable game speed in spectator mode
- Mobile-friendly with touch support
- Responsive design that scales to fit your screen
- Battle history replay

## Usage

### Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the modern development server:

   ```bash
   npm run dev
   ```

3. To test the legacy build run:

   ```bash
   npm run dev:legacy
   ```

4. Open your browser at `http://localhost:3000`

### Production Build

Modern build:

```bash
npm run build
```

Legacy build:

```bash
npm run build:legacy
```

Build both at once:

```bash
npm run build:all
```

The optimized files will be available in the `dist` directory and can be deployed to any web server.

### Bundle Analysis

Generate a bundle report to inspect the contents of the production build:

```bash
npm run build:analyze
```

Open `dist/bundle-report.html` to view the visualization. To enforce bundle size limits, run:

```bash
npm run perf:check
```

### Game Modes

- **Player vs AI**: Test your strategy against various AI opponents (default)
- **AI vs AI**: Watch AI players compete against each other in spectator mode
- **Battle Speed**: Adjust game speed in spectator mode for faster analysis

You can select "AI vs AI" on the title screen to enter spectator mode.

## Make Your Own AI

This project makes it easy to develop and test custom AI strategies.

### Modern Method (Recommended)

1. Create a new file in the `src/ai` directory:

   ```javascript
   // src/ai/ai_YourName.js
   export function ai_YourName(game) {
     // Your AI implementation here
     return 0; // Return 0 when done with turn
   }
   ```

2. Register your AI in `src/ai/index.js`:

   ```javascript
   export { ai_YourName } from './ai_YourName.js';
   ```

3. Add your AI to the registry in `src/Game.js`:
   ```javascript
   this.aiRegistry = {
     // Existing AIs...
     ai_YourName: ai_YourName,
   };
   ```

### AI Implementation Guide

Your AI function receives the game state and needs to make decisions about which territories to attack:

```javascript
function ai_YourName(game) {
  // Example: Find a territory you own with dice > 1
  const myTerritories = game.adat.filter(area => area.arm === game.get_pn() && area.dice > 1);

  if (myTerritories.length === 0) return 0; // End turn if no valid moves

  // For each territory, check neighbors for potential attacks
  for (const myArea of myTerritories) {
    const areaId = game.adat.indexOf(myArea);

    // Find enemy neighbors
    for (let j = 0; j < game.adat.length; j++) {
      if (myArea.join[j] && game.adat[j].arm !== game.get_pn()) {
        // Evaluate if attack is favorable
        if (myArea.dice > game.adat[j].dice) {
          // Attack! Set source and target areas
          game.area_from = areaId;
          game.area_to = j;
          return; // Don't return a value to execute the attack
        }
      }
    }
  }

  return 0; // End turn when no good moves are found
}
```

### Game State Reference

- `game.adat`: Array of all territories
- `game.adat[i].arm`: Player ID who owns territory `i`
- `game.adat[i].dice`: Number of dice in territory `i`
- `game.adat[i].join[j]`: Returns 1 if territories `i` and `j` are adjacent, 0 otherwise
- `game.get_pn()`: Current player's ID
- `game.area_from`: Set to the ID of attacking territory
- `game.area_to`: Set to the ID of defending territory

### Testing Your AI

You can test your AI by:

1. Changing the player assignments in `Game.js`
2. Using spectator mode to watch your AI compete against others
3. Analyzing performance statistics (if enabled)

## Configuration

Game settings can be configured through the settings UI or by editing configuration files:

```javascript
// Example configuration in src/config.js
export const GAME_CONFIG = {
  playerCount: 8, // Number of players (2-8)
  humanPlayerIndex: 0, // Set to null for AI vs AI mode
  spectatorSpeedMultiplier: 3, // Game speed in spectator mode
  soundEnabled: true, // Enable/disable game sounds
  battleHistoryLength: 10, // Number of battles to keep in history
  showProbabilities: true, // Show attack success probability
  territoriesCount: 40, // Number of territories
  maxDice: 8, // Maximum dice per territory
};
```

## Project Architecture

This project is transitioning to a modern architecture. The `src/` directory contains all modern ES6+ code and represents the future direction of the codebase. Legacy scripts located in the root directory (e.g., `game.js`, `main.js`, `areadice.js`, `mc.js`) are being progressively migrated into the `src/` structure or replaced by ES6 modules.

```
dicewarsjs/
├── src/                     # Source files (modern ES6 code - the future!)
│   ├── ai/                  # AI implementations
│   ├── adapters/            # Adapters for difficult-to-migrate legacy code (e.g., MCAdapter.js)
│   ├── bridge/              # Bridge modules (temporary, for legacy compatibility)
│   ├── mechanics/           # Core game mechanics (e.g., map generation, battle logic)
│   ├── models/              # Data structures
│   ├── state/               # Game state management
│   ├── ui/                  # UI components and logic
│   ├── utils/               # Utility functions
│   ├── Game.js              # Modern main game class
│   └── index.js             # Main entry point for the modern application
├── game.js                  # Legacy game logic (being migrated to src/Game.js and src/mechanics/)
├── main.js                  # Legacy main script (being migrated to src/ui/ and src/index.js)
├── mc.js                    # Legacy Flash-generated graphics library (interfaced via MCAdapter.js)
├── areadice.js              # Legacy utility (being migrated)
├── dist/                    # Production build output
├── docs/                    # Documentation
│   ├── ai-strategies/       # AI strategy documentation
│   └── ...                  # Other documentation
├── webpack.common.js        # Shared webpack configuration
├── webpack.legacy.js        # Legacy build config
├── webpack.modern.js        # Modern ES module build config
├── .eslintrc.js             # ESLint configuration
└── package.json             # Dependencies and scripts
```

### Current Architecture

The codebase is in a hybrid state: legacy JavaScript (root-level files using CreateJS) coexists with modern ES6 modules (`src/`). A bridge layer (`src/bridge/`) was previously used to connect them but is now deprecated. The [Modernization Roadmap](./docs/MODERNIZATION_ROADMAP.md) details the plan to replace the legacy rendering with PixiJS, extract a pure game engine, and build a Bot SDK and arena system.

## Development Workflow

### Available Scripts

```bash
# Start development server
npm run dev

# Start legacy development server
npm run dev:legacy

# Build for production
npm run build

# Build legacy bundle
npm run build:legacy

# Build both bundles
npm run build:all

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix

# Format code with Prettier
npm run format

# Run tests
npm run test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

### Pre-commit Checklist

Before committing any changes, ensure all quality checks pass:

1. **Run Tests**: All tests must pass

   ```bash
   npm test
   ```

   Expected result: All tests pass with no failures

2. **Format Code**: Ensure code formatting is consistent

   ```bash
   npm run format
   ```

   This will automatically format your code using Prettier

3. **Check Linting**: No linting errors should be present

   ```bash
   npm run lint
   ```

   Expected result: No errors (warnings are acceptable but should be minimized)

   To automatically fix linting issues:

   ```bash
   npm run lint:fix
   ```

4. **Verify Build**: Ensure the project builds successfully
   ```bash
   npm run build
   ```
   Expected result: Build completes without errors

If any of these checks fail, fix the issues before committing your changes. This ensures code quality and prevents breaking the build for other developers.

### Code Quality Tools

- **ESLint**: Enforces coding standards
- **Prettier**: Ensures consistent code formatting
- **Jest**: For unit and integration testing
- **Webpack**: Bundles and optimizes code

Pre-commit hooks automatically format and lint changed files.

## Roadmap Highlights

See the [Modernization Roadmap](./docs/MODERNIZATION_ROADMAP.md) for the full plan. Key goals:

- Replace CreateJS rendering with PixiJS (WebGL-accelerated)
- Extract a pure, renderer-independent game engine
- Build a Bot SDK so anyone can write a competing AI in a single file
- Create an arena system with ELO rankings and replay viewer
- Make the project easy for the community to contribute to

## Available AI Types

Several AI implementations are included to demonstrate different strategies:

- **Example AI** (`ai_example.js`): Basic implementation to learn from
- **Default AI** (`ai_default.js`): Original game's AI strategy
- **Defensive AI** (`ai_defensive.js`): Prioritizes protecting vulnerable territories
- **Adaptive AI** (`ai_adaptive.js`): Adjusts strategy based on game state

## Documentation

Comprehensive documentation is available in the `docs/` directory:

> **Note for Contributors**: When making significant changes to the codebase, please ensure that relevant documentation is updated accordingly. This includes architecture docs, API references, and any affected development guides.

- [**Modernization Roadmap**](./docs/MODERNIZATION_ROADMAP.md): Project vision, architecture, and phased plan
- [**AI Developer Guide**](./docs/ai/DEVELOPER_GUIDE.md): Guide for creating custom AI strategies
- [**AI Strategies**](./docs/ai-strategies/README.md): Detailed documentation of AI strategy patterns

For AI coding assistants:

- [**CLAUDE.md**](./CLAUDE.md): Guidance for Claude Code
- [**AGENTS.md**](./AGENTS.md): Guidance for other AI assistants
  (These files are kept in sync to ensure consistent assistance)
- [**Code Style Guide**](./docs/CODE_STYLE.md): Coding standards and conventions
- [**Testing Strategy**](./docs/TESTING.md): Testing approach and implementation

## Module Federation

DiceWarsJS can participate in a module federation setup. It can expose its AI
modules as a **remote** or consume them as a **host**.

### Run as a remote

Start the development server with the `role` set to `remote` and optionally
specify a port (defaults to `3000`):

```bash
npm run dev -- --env role=remote --env port=3001
```

This generates `remoteEntry.js` and exposes modules like `./AI` and `./Game`.

### Run as a host

To consume modules from another running instance, set the `role` to `host` and
provide the remote URL:

```bash
npm run dev -- --env role=host --env remoteUrl=http://localhost:3001
```

The host application will load the exposed modules from the remote instance at
the given URL.

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Update relevant documentation for any significant changes (including CLAUDE.md/AGENTS.md if workflow changes)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

If you create a cool new AI strategy, please share it with the community!

## License

[MIT](LICENSE) - Feel free to use, modify, and distribute this code.

## Acknowledgments

- Original game design by [GameDesign.jp](https://www.gamedesign.jp/games/dicewars/)
- Initial JavaScript implementation by [Chris Raff](https://github.com/chrisraff/dicewarsjs)
