#!/usr/bin/env node

/**
 * Online Tournament Runner
 *
 * Runs a tournament with built-in + community bots, persists ELO ratings,
 * saves leaderboard and replay data to public/data/ for the frontend.
 *
 * Usage:
 *   node scripts/run-online-tournament.mjs                 # 100 games (default)
 *   node scripts/run-online-tournament.mjs --games 50      # 50 games
 */

import fs from 'node:fs';
import path from 'node:path';
import { runArena } from '../src/arena/arenaRunner.js';
import { DEFAULT_MAX_TURNS } from '../src/arena/matchRunner.js';
import { createReplay } from '../src/arena/replayFormat.js';
import { buildTournamentField } from './lib/tournament-field.mjs';
import { buildLeaderboard, buildHistoryEntry } from './lib/online-tournament.mjs';
import { getArg, colors } from './lib/cli-utils.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const REPLAYS_DIR = path.join(DATA_DIR, 'replays');
const COMMUNITY_DIR = path.join(ROOT, 'community-bots');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');
const HISTORY_PATH = path.join(DATA_DIR, 'tournament-history.json');
const REGISTRY_PATH = path.join(COMMUNITY_DIR, 'registry.json');

const MAX_REPLAYS = 10;

// --- Parse CLI args ---

const args = process.argv.slice(2);
const gameCount = parseInt(getArg(args, 'games', '100'), 10);
if (!Number.isFinite(gameCount) || gameCount < 1) {
  console.error('Invalid --games value. Must be a positive integer.');
  process.exit(1);
}

// --- Ensure directories exist ---

fs.mkdirSync(REPLAYS_DIR, { recursive: true });

// --- Load previous leaderboard for persistent ELO ---

let previousLeaderboard = { updatedAt: null, tournamentCount: 0, totalGamesPlayed: 0, bots: [] };
if (fs.existsSync(LEADERBOARD_PATH)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEADERBOARD_PATH, 'utf-8'));
    // Only use if it has data — a seed file with no bots is fine to overwrite
    if (parsed.bots && parsed.bots.length > 0) {
      previousLeaderboard = parsed;
    }
  } catch (err) {
    console.error(
      `${colors.red}Error: Could not parse previous leaderboard: ${err.message}${colors.reset}`
    );
    console.error('Run with a valid leaderboard.json or delete it to start fresh.');
    process.exit(1);
  }
}

const initialRatings = {};
for (const bot of previousLeaderboard.bots) {
  initialRatings[bot.name] = bot.elo;
}

// --- Load bots ---

/*
 * The field is the player-visible built-in roster (the hidden dev-harness nets
 * BC/PPO are excluded, so they never surface on the public leaderboard) plus
 * every active community bot, author-namespaced so a community name can't
 * collide with a first-party built-in (e.g. the "Blitz" persona vs. the
 * community "Blitz"). See scripts/lib/tournament-field.mjs.
 */
let registry = [];
if (fs.existsSync(REGISTRY_PATH)) {
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch (err) {
    console.error(
      `${colors.red}Error: Could not parse community bot registry: ${err.message}${colors.reset}`
    );
    process.exit(1);
  }
}

const { bots, authorByName } = buildTournamentField({
  registry,
  communityDir: COMMUNITY_DIR,
  onWarn: msg => console.warn(`${colors.yellow}${msg}${colors.reset}`),
  onLoad: name => console.log(`  Loaded community bot: ${name}`),
});

if (bots.length < 2) {
  console.error('Need at least 2 bots to run a tournament.');
  process.exit(1);
}

// --- Run tournament ---

console.log(
  `\n${colors.bold}Running tournament: ${gameCount} games with ${bots.length} bots${colors.reset}\n`
);

// Date-based seed: reproducible within the same day, varies between days
const today = new Date();
const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

const result = runArena({
  bots,
  gameCount,
  baseSeed: dateSeed,
  maxTurns: DEFAULT_MAX_TURNS,
  initialRatings,
  onGameComplete: i => {
    if ((i + 1) % 10 === 0 || i + 1 === gameCount) {
      process.stdout.write(`  ${i + 1}/${gameCount} games\r`);
    }
  },
});

console.log('');

if (result.aborted) {
  console.error(
    `${colors.red}Tournament aborted due to excessive failures (${result.failedGames} failed).${colors.reset}`
  );
  process.exit(1);
}

// --- Select notable replays ---

/*
 * Pick the longest *decisive* games — a game that someone actually won is a far
 * better showcase than a stalemate that ran out the turn cap. Among decisive
 * games, longer ones tend to be the most competitive, back-and-forth matches.
 */
const replayMatches = result.matches
  .filter(m => m.finalState && m.winner !== null && m.turnCount > 5)
  .map(m => {
    const botNames = m.botStats.map(s => s.name);
    return { match: m, botNames, turnCount: m.turnCount };
  })
  .sort((a, b) => b.turnCount - a.turnCount) // longest decisive games are most interesting
  .slice(0, MAX_REPLAYS);

// Clear old replays
const existingReplays = fs.readdirSync(REPLAYS_DIR).filter(f => f.endsWith('.json'));
for (const f of existingReplays) {
  fs.unlinkSync(path.join(REPLAYS_DIR, f));
}

// Save new replays
const replayFiles = [];
for (let i = 0; i < replayMatches.length; i++) {
  const { match, botNames } = replayMatches[i];
  const replay = createReplay(match, botNames);
  const filename = `replay-${i + 1}.json`;
  fs.writeFileSync(path.join(REPLAYS_DIR, filename), JSON.stringify(replay));
  replayFiles.push({
    file: filename,
    bots: botNames,
    winner: match.winner !== null ? botNames[match.winner] : null,
    turns: match.turnCount,
  });
}

// --- Flag broken bots ---

/*
 * runArena already console.warned about any bot that errored on most of its turns. Exclude
 * those flagged bots from the durable artifacts below: a broken bot's meaningless ELO must
 * not reach the public leaderboard, and — since the next run seeds initialRatings from this
 * file — it must not compound day-over-day. Loudly note the exclusion (the reportBotErrors
 * warning explains why; this states the consequence). (#53, #92 item 1)
 */
if (result.flagged.length > 0) {
  const names = result.flagged.map(f => f.name).join(', ');
  console.warn(
    `${colors.yellow}Excluding ${result.flagged.length} flagged bot(s) from the published ` +
      `leaderboard + ELO seeding (broken/mis-registered — win%/ELO not a real measurement): ` +
      `${names}${colors.reset}`
  );
}

// --- Build leaderboard ---

const leaderboard = buildLeaderboard({
  result,
  previousLeaderboard,
  authorByName,
  replayFiles,
  updatedAt: today.toISOString(),
});

// --- Build tournament history entry ---

let history = [];
if (fs.existsSync(HISTORY_PATH)) {
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch (err) {
    console.warn(
      `${colors.yellow}Warning: Could not parse tournament history (${err.message}), starting fresh.${colors.reset}`
    );
    history = [];
  }
}

history.push(
  buildHistoryEntry({
    result,
    date: today.toISOString().split('T')[0],
    botCount: bots.length,
  })
);

// Keep last 90 days of history
if (history.length > 90) {
  history = history.slice(-90);
}

// --- Write output ---

fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(leaderboard, null, 2));
fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

// --- Print results ---

console.log(`${colors.bold}Results:${colors.reset}\n`);
console.log(
  `${'Rank'.padEnd(6)}${'Bot'.padEnd(26)}${'ELO'.padEnd(8)}${'Wins'.padEnd(8)}${'Win%'.padEnd(8)}${'Avg Place'.padEnd(10)}${'Atk Win%'.padEnd(10)}`
);
console.log('-'.repeat(76));

// Mark flagged (excluded) bots in the operator table — the published leaderboard omits them.
const flaggedNames = new Set(result.flagged.map(f => f.name));
for (let i = 0; i < result.bots.length; i++) {
  const b = result.bots[i];
  const winPct = b.gamesPlayed > 0 ? ((b.wins / b.gamesPlayed) * 100).toFixed(1) : '0.0';
  const name = flaggedNames.has(b.name) ? `${b.name} ⚠` : b.name;
  console.log(
    `${String(i + 1).padEnd(6)}${name.padEnd(26)}${String(Math.round(b.elo)).padEnd(8)}${String(b.wins).padEnd(8)}${`${winPct}%`.padEnd(8)}${String(b.avgPlacement).padEnd(10)}${`${(b.attackWinRate * 100).toFixed(1)}%`.padEnd(10)}`
  );
}

console.log(
  `\n${colors.green}Leaderboard saved to ${path.relative(ROOT, LEADERBOARD_PATH)}${colors.reset}`
);
console.log(
  `${colors.green}${replayFiles.length} replay(s) saved to ${path.relative(ROOT, REPLAYS_DIR)}/${colors.reset}`
);
