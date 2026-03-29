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

To submit a bot:

1. Open an issue using the **Bot Submission** template
2. Or create a PR adding your bot to the `bots/` directory

## Project Structure

See [Architecture](docs/ARCHITECTURE.md) for how the codebase is organized.

## Getting Help

- Open an issue for bugs or questions
- Check existing issues and docs before asking
- Be specific about what you've tried and what went wrong

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please be respectful and constructive.
