/**
 * Regression coverage for the online-tournament field builder
 * (`scripts/lib/tournament-field.mjs`), the seam behind the daily
 * `npm run tournament` → `public/data/leaderboard.json`.
 *
 * Guards the two foot-guns that motivated extracting it:
 *  1. **No hidden dev nets on the public board.** The field is the player-visible
 *     roster, so `BC`/`PPO` never appear (and the PPO/Conqueror weight duplicate
 *     collapses to just Conqueror).
 *  2. **No name collisions.** `runArena`/`runRoundRobin` throw on duplicate names.
 *     A first-party built-in and a community bot can share a bare name (the
 *     built-in "Blitz" persona vs. the community "Blitz" bot) — author-namespacing
 *     community bots keeps the field unique so the daily tournament can't crash.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTournamentField, communityDisplayName } from '../../scripts/lib/tournament-field.mjs';
import { PLAYER_VISIBLE_BOTS } from '../../src/arena/builtInBots.js';

const here = dirname(fileURLToPath(import.meta.url));
const COMMUNITY_DIR = resolve(here, '../../community-bots');

describe('communityDisplayName', () => {
  it('author-namespaces a community bot so it cannot collide with a bare built-in name', () => {
    expect(communityDisplayName({ name: 'Blitz', author: 'bigintersmind' })).toBe(
      'Blitz (bigintersmind)'
    );
  });
});

describe('buildTournamentField — player-visible roster', () => {
  it('excludes the hidden dev-harness nets (BC/PPO) and includes the personas', () => {
    const { bots } = buildTournamentField({ communityDir: COMMUNITY_DIR });
    const names = bots.map(b => b.name);

    // C2: hidden nets must not reach the public leaderboard.
    expect(names).not.toContain('BC');
    expect(names).not.toContain('PPO');
    // The player-facing persona roster is present.
    expect(names).toEqual(expect.arrayContaining(['Conqueror', 'Blitz', 'Survivor']));
    // With no registry, the field is exactly the player-visible built-ins.
    expect(names).toEqual(PLAYER_VISIBLE_BOTS.map(b => b.name));
  });

  it('tags every player-visible built-in as author "built-in"', () => {
    const { authorByName } = buildTournamentField({ communityDir: COMMUNITY_DIR });
    for (const bot of PLAYER_VISIBLE_BOTS) {
      expect(authorByName.get(bot.name)).toBe('built-in');
    }
  });
});

describe('buildTournamentField — community bots (real registry)', () => {
  const registry = [
    {
      name: 'Connector',
      author: 'bigintersmind',
      file: 'bigintersmind/connector.js',
      active: true,
    },
    { name: 'Blitz', author: 'bigintersmind', file: 'bigintersmind/blitz.js', active: true },
    {
      name: 'Giant Slayer',
      author: 'bigintersmind',
      file: 'bigintersmind/giant-slayer.js',
      active: true,
    },
  ];

  it('produces a field with unique names — the community "Blitz" no longer collides with the persona "Blitz"', () => {
    const { bots } = buildTournamentField({ registry, communityDir: COMMUNITY_DIR });
    const names = bots.map(b => b.name);

    // The exact invariant runArena/runRoundRobin enforce (they throw otherwise).
    expect(new Set(names).size).toBe(names.length);

    // Both "Blitz" bots are present, distinguished by the namespace.
    expect(names).toContain('Blitz'); // the first-party persona
    expect(names).toContain('Blitz (bigintersmind)'); // the community bot
  });

  it('maps namespaced community names back to their author for the leaderboard', () => {
    const { authorByName } = buildTournamentField({ registry, communityDir: COMMUNITY_DIR });
    expect(authorByName.get('Blitz (bigintersmind)')).toBe('bigintersmind');
    expect(authorByName.get('Connector (bigintersmind)')).toBe('bigintersmind');
    // The bare "Blitz" is still the built-in persona, not the community bot.
    expect(authorByName.get('Blitz')).toBe('built-in');
  });

  it('keeps the field unique even when a community bot shares a name with a persona (e.g. "Conqueror")', () => {
    // A community entry whose bare name collides with a first-party persona — the
    // exact class of collision namespacing must neutralize. (Compiles a real bot
    // file under the colliding display name.)
    const colliding = [
      { name: 'Conqueror', author: 'someone', file: 'bigintersmind/blitz.js', active: true },
    ];
    const { bots, authorByName } = buildTournamentField({
      registry: colliding,
      communityDir: COMMUNITY_DIR,
    });
    const names = bots.map(b => b.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('Conqueror'); // the persona
    expect(names).toContain('Conqueror (someone)'); // the community bot
    expect(authorByName.get('Conqueror')).toBe('built-in');
    expect(authorByName.get('Conqueror (someone)')).toBe('someone');
  });

  it('disambiguates two community entries with the SAME name AND author (no duplicate crash)', () => {
    /*
     * Author-namespacing alone does NOT make community entries unique: two active
     * registry rows with the same name and author collapse to one string ("Raider
     * (alice)") and runArena throws "Bot names must be unique", aborting the daily
     * tournament — the exact failure class the fix exists to prevent. The " #n"
     * suffix keeps the field globally unique regardless of registry contents.
     */
    const dupes = [
      { name: 'Raider', author: 'alice', file: 'bigintersmind/blitz.js', active: true },
      { name: 'Raider', author: 'alice', file: 'bigintersmind/connector.js', active: true },
    ];
    const { bots, authorByName } = buildTournamentField({
      registry: dupes,
      communityDir: COMMUNITY_DIR,
    });
    const names = bots.map(b => b.name);

    expect(new Set(names).size).toBe(names.length); // the runArena/runRoundRobin invariant
    expect(names).toContain('Raider (alice)');
    expect(names).toContain('Raider (alice) #2');
    expect(authorByName.get('Raider (alice)')).toBe('alice');
    expect(authorByName.get('Raider (alice) #2')).toBe('alice');
  });

  it('skips (does not throw on) inactive, missing, or traversing entries', () => {
    const warnings = [];
    const messy = [
      { name: 'Inactive', author: 'x', file: 'bigintersmind/blitz.js', active: false },
      { name: 'Missing', author: 'x', file: 'bigintersmind/does-not-exist.js', active: true },
      { name: 'Escape', author: 'x', file: '../../package.json', active: true },
    ];
    const { bots } = buildTournamentField({
      registry: messy,
      communityDir: COMMUNITY_DIR,
      onWarn: msg => warnings.push(msg),
    });
    const names = bots.map(b => b.name);
    // None of the messy entries make it into the field.
    expect(names).toEqual(PLAYER_VISIBLE_BOTS.map(b => b.name));
    // The missing + traversing entries each warned (the inactive one is filtered silently).
    expect(warnings.some(w => w.includes('Missing'))).toBe(true);
    expect(warnings.some(w => w.includes('Escape'))).toBe(true);
  });
});
