import { runRoundRobin, runSingleElimination } from '../../src/arena/tournament.js';
import { adaptLegacyBot } from '../../src/arena/legacyBotAdapter.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { ai_default } from '../../src/ai/ai_default.js';

const exampleBot = { name: 'Example', fn: adaptLegacyBot(ai_example, 'Example') };
const defaultBot = { name: 'Default', fn: adaptLegacyBot(ai_default, 'Default') };

describe('runRoundRobin', () => {
  it('runs a round-robin tournament', () => {
    const result = runRoundRobin({
      bots: [exampleBot, defaultBot],
      gamesPerPairing: 2,
      baseSeed: 1,
    });

    expect(result.type).toBe('round-robin');
    expect(result.totalGames).toBeGreaterThan(0);
    expect(result.standings.length).toBe(2);
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.champion).toBeTruthy();
  });

  it('standings have correct shape', () => {
    const result = runRoundRobin({
      bots: [exampleBot, defaultBot],
      gamesPerPairing: 1,
      baseSeed: 1,
    });

    for (const s of result.standings) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.wins).toBe('number');
      expect(typeof s.losses).toBe('number');
      expect(typeof s.gamesPlayed).toBe('number');
      expect(typeof s.elo).toBe('number');
      expect(typeof s.points).toBe('number');
    }
  });

  it('all bots play the same number of games', () => {
    const result = runRoundRobin({
      bots: [exampleBot, defaultBot],
      gamesPerPairing: 3,
      baseSeed: 1,
    });

    const games = result.standings.map(s => s.gamesPlayed);
    expect(new Set(games).size).toBe(1);
  });

  it('handles 3+ bots', () => {
    const bots = [
      exampleBot,
      defaultBot,
      { name: 'Example2', fn: adaptLegacyBot(ai_example, 'Example2') },
    ];

    const result = runRoundRobin({
      bots,
      gamesPerPairing: 1,
      playersPerGame: 2,
      baseSeed: 1,
    });

    expect(result.standings.length).toBe(3);
    // With 3 bots and 2 players per game, there should be C(3,2) = 3 pairings
    expect(result.rounds.length).toBe(3);
  });

  it('standings are sorted by points descending', () => {
    const result = runRoundRobin({
      bots: [exampleBot, defaultBot],
      gamesPerPairing: 3,
      baseSeed: 1,
    });

    for (let i = 1; i < result.standings.length; i++) {
      expect(result.standings[i - 1].points).toBeGreaterThanOrEqual(result.standings[i].points);
    }
  });

  it('calls onMatchComplete callback', () => {
    const calls = [];
    runRoundRobin({
      bots: [exampleBot, defaultBot],
      gamesPerPairing: 1,
      baseSeed: 1,
      onMatchComplete: (roundIdx, matchIdx, r) => {
        calls.push({ roundIdx, matchIdx, winner: r.winner });
      },
    });

    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('runSingleElimination', () => {
  it('runs a single-elimination tournament', () => {
    const result = runSingleElimination({
      bots: [exampleBot, defaultBot],
      gamesPerRound: 1,
      baseSeed: 1,
    });

    expect(result.type).toBe('single-elimination');
    expect(result.totalGames).toBeGreaterThan(0);
    expect(result.standings.length).toBe(2);
    expect(result.champion).toBeTruthy();
  });

  it('produces a single champion', () => {
    const bots = [
      exampleBot,
      defaultBot,
      { name: 'Example2', fn: adaptLegacyBot(ai_example, 'Example2') },
      { name: 'Default2', fn: adaptLegacyBot(ai_default, 'Default2') },
    ];

    const result = runSingleElimination({
      bots,
      gamesPerRound: 1,
      baseSeed: 1,
    });

    expect(result.champion).toBeTruthy();
    expect(bots.some(b => b.name === result.champion)).toBe(true);
  });

  it('handles odd number of bots (byes)', () => {
    const bots = [
      exampleBot,
      defaultBot,
      { name: 'Example2', fn: adaptLegacyBot(ai_example, 'Example2') },
    ];

    const result = runSingleElimination({
      bots,
      gamesPerRound: 1,
      baseSeed: 1,
    });

    expect(result.champion).toBeTruthy();
    expect(result.standings.length).toBe(3);
  });

  it('best-of series uses gamesPerRound', () => {
    const result = runSingleElimination({
      bots: [exampleBot, defaultBot],
      gamesPerRound: 3,
      baseSeed: 1,
    });

    // 2 bots, 1 round, 3 games per round
    expect(result.totalGames).toBe(3);
  });

  it('calls onMatchComplete callback', () => {
    const calls = [];
    runSingleElimination({
      bots: [exampleBot, defaultBot],
      gamesPerRound: 1,
      baseSeed: 1,
      onMatchComplete: (roundIdx, gameIdx, r) => {
        calls.push({ roundIdx, gameIdx, winner: r.winner });
      },
    });

    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('tournament error observability (#53)', () => {
  const brokenBot = {
    name: 'Broken',
    fn: () => {
      throw new Error('boom');
    },
  };

  it('round-robin standings expose errors/invalidMoves/maxMovesHit (zero for healthy bots)', () => {
    const result = runRoundRobin({
      bots: [exampleBot, defaultBot],
      gamesPerPairing: 1,
      baseSeed: 1,
    });

    for (const s of result.standings) {
      expect(typeof s.errors).toBe('number');
      expect(typeof s.invalidMoves).toBe('number');
      expect(typeof s.maxMovesHit).toBe('number');
      expect(s.errors).toBe(0);
    }
  });

  it('round-robin accumulates errors and warns when a bot errors every turn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = runRoundRobin({
      bots: [brokenBot, defaultBot],
      gamesPerPairing: 2,
      baseSeed: 1,
    });

    const broken = result.standings.find(s => s.name === 'Broken');
    expect(broken.errors).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[Tournament\] bot "Broken".*error fraction 100\.0%/s)
    );

    warnSpy.mockRestore();
  });

  it('single-elimination accumulates errors and warns when a bot errors every turn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = runSingleElimination({
      bots: [brokenBot, defaultBot],
      gamesPerRound: 2,
      baseSeed: 1,
    });

    const broken = result.standings.find(s => s.name === 'Broken');
    expect(broken.errors).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[Tournament\] bot "Broken".*error fraction 100\.0%/s)
    );

    warnSpy.mockRestore();
  });
});
