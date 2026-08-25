# Contributing to DiceWarsJS

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/<your-username>/dicewarsjs.git
   cd dicewarsjs
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Start the dev server**:

   ```bash
   npm run dev
   ```

   Open `http://localhost:3000` in your browser.

## Quality Checks

Run these before submitting a PR:

```bash
npm test            # All tests pass
npm run lint        # No lint errors
npm run build       # Production build succeeds
```

Pre-commit hooks automatically format and lint staged files.

## Branch Naming

Use descriptive branch names with a prefix:

- `feat/bot-tournament-brackets`
- `fix/dice-renderer-overflow`
- `docs/update-bot-guide`
- `test/arena-edge-cases`

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

- `feat: add round-robin tournament mode`
- `fix: correct dice count after reinforcement`
- `docs: update bot SDK examples`
- `test: add edge cases for battle resolver`
- `refactor: simplify hex grid neighbor lookup`

## Pull Request Process

1. Create a feature branch from `master`
2. Make your changes with tests
3. Run the quality checks above
4. Open a PR with a clear description of what and why
5. Fill out the PR template

## Writing a Bot

The easiest way to contribute is to write a bot! See the [Bot Guide](docs/BOT_GUIDE.md) for the full SDK reference and the [bots/](bots/) directory for examples at different complexity levels.

### Submit a Bot to the Online Arena

Community bots compete in daily automated tournaments with a persistent ELO leaderboard. To submit yours:

1. **Fork** the repository and create a branch
2. **Create your bot directory**: `community-bots/<your-github-username>/`
3. **Add your bot file** (e.g., `my-bot.js`): a bare function body that receives `state` and returns `{ from, to }` or `null`. Same format as the bots in `bots/`.
4. **Add a metadata file** (e.g., `my-bot.meta.json`):
   ```json
   {
     "name": "My Bot",
     "author": "<your-github-username>",
     "description": "Brief description of your bot's strategy"
   }
   ```
5. **Register your bot** in `community-bots/registry.json`:
   ```json
   {
     "id": "<your-github-username>/my-bot",
     "name": "My Bot",
     "author": "<your-github-username>",
     "file": "<your-github-username>/my-bot.js",
     "description": "Brief description of your bot's strategy",
     "submittedAt": "2026-01-01T00:00:00Z",
     "active": true
   }
   ```
6. **Open a PR**: CI will automatically validate your bot (syntax, compilation, test match)

You can also test locally before submitting:

```bash
npm run validate-bot -- community-bots/<your-username>/my-bot.js --test
```

## Project Structure

See [Architecture](docs/ARCHITECTURE.md) for how the codebase is organized.

## Getting Help

- Open an issue for bugs or questions
- Check existing issues and docs before asking
- Be specific about what you've tried and what went wrong

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please be respectful and constructive.
