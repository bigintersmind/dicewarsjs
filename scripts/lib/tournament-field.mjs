/**
 * Online-tournament field builder.
 *
 * Extracted from `scripts/run-online-tournament.mjs` so the field composition —
 * the part that decides *which* bots compete and *what name* each one carries —
 * is a pure, importable unit with a regression test, rather than logic buried in
 * a script that runs a whole tournament on import.
 *
 * Two invariants this module exists to protect (both were live foot-guns):
 *  1. **Player-visible roster only.** The public leaderboard must not surface the
 *     hidden dev-harness nets (`BC`/`PPO`) — so the field is built from
 *     {@link PLAYER_VISIBLE_BOTS}, not the full `BUILT_IN_BOTS`. (This also drops
 *     the `PPO`/`Conqueror` duplicate: Conqueror ships the same weights as the
 *     hidden PPO, so only Conqueror remains.)
 *  2. **No name collisions.** `runArena`/`runRoundRobin` reject a field with any
 *     duplicate name. A built-in and a community bot can share a name (e.g. the
 *     first-party "Blitz" persona vs. the community "Blitz" bot), which would
 *     crash the daily tournament. Community bots are therefore author-namespaced
 *     (`"<name> (<author>)"`) to clear the first-party names, and then every
 *     display name is reserved with a `" #n"` suffix on any residual duplicate
 *     (two registry entries with the same name AND author would otherwise collapse
 *     to one string) — so the field is guaranteed globally unique regardless of
 *     what the registry contains.
 *
 * @module scripts/lib/tournament-field
 */

import fs from 'node:fs';
import path from 'node:path';

import { PLAYER_VISIBLE_BOTS } from '../../src/arena/builtInBots.js';
import { compileSandboxedBot } from './bot-sandbox.mjs';

/**
 * Author-namespaced display name for a community bot: `"<name> (<author>)"`.
 * Keeps community entries from colliding with a same-named first-party built-in.
 *
 * @param {{ name: string, author: string }} entry - a community registry entry
 * @returns {string}
 */
export function communityDisplayName(entry) {
  return `${entry.name} (${entry.author})`;
}

/**
 * Build the online-tournament field: the player-visible built-in roster plus
 * every active, safely-compilable community bot (each author-namespaced).
 *
 * File I/O (reading + sandbox-compiling each community bot) happens here; unsafe
 * or missing entries are skipped via `onWarn` rather than aborting the field.
 *
 * @param {Object} opts
 * @param {Array<{ name: string, author: string, file: string, active?: boolean }>} [opts.registry]
 *   the parsed community-bot registry (defaults to none)
 * @param {string} opts.communityDir - absolute path to the community-bots directory
 * @param {(msg: string) => void} [opts.onWarn] - called with a message for each skipped bot
 * @param {(name: string) => void} [opts.onLoad] - called with the display name of each loaded bot
 * @returns {{ bots: Array<{ name: string, fn: Function }>, authorByName: Map<string, string> }}
 *   `bots` is ready for `runArena`; `authorByName` maps each display name to its author
 *   (`'built-in'` for first-party bots) for the leaderboard.
 */
export function buildTournamentField({
  registry = [],
  communityDir,
  onWarn = () => {},
  onLoad = () => {},
} = {}) {
  const bots = [];
  const authorByName = new Map();

  /*
   * runArena/runRoundRobin throw on ANY duplicate name, so reserve each display
   * name and disambiguate a residual collision with a " #n" suffix (the same tactic
   * selfplay-core/ppo-env use for duplicate seats). Built-ins are reserved first, so
   * they keep their bare names; author-namespacing already clears community bots of
   * first-party names, and this closes the community-vs-community case (two registry
   * entries with the same name AND author).
   */
  const taken = new Set();
  const claimUnique = base => {
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} #${n}`;
    taken.add(name);
    return name;
  };

  for (const b of PLAYER_VISIBLE_BOTS) {
    const name = claimUnique(b.name);
    bots.push({ name, fn: b.fn });
    authorByName.set(name, 'built-in');
  }

  const activeBots = Array.isArray(registry) ? registry.filter(e => e.active !== false) : [];
  for (const entry of activeBots) {
    const botPath = path.join(communityDir, entry.file);
    // Guard against path traversal (e.g. "../../.env")
    if (!path.resolve(botPath).startsWith(communityDir + path.sep)) {
      onWarn(`Skipping ${entry.name}: path traversal detected (${entry.file})`);
      continue;
    }
    if (!fs.existsSync(botPath)) {
      onWarn(`Skipping ${entry.name}: file not found (${entry.file})`);
      continue;
    }

    let fn;
    try {
      fn = compileSandboxedBot(fs.readFileSync(botPath, 'utf-8'), entry.name);
    } catch (err) {
      onWarn(`Skipping ${entry.name}: ${err.message}`);
      continue;
    }

    const name = claimUnique(communityDisplayName(entry));
    bots.push({ name, fn });
    authorByName.set(name, entry.author);
    onLoad(name);
  }

  return { bots, authorByName };
}
