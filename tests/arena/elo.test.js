import { expectedScore, updateEloRatings, DEFAULT_RATING, DEFAULT_K } from '../../src/arena/elo.js';

describe('expectedScore', () => {
  it('returns 0.5 for equal ratings', () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
  });

  it('returns higher value for higher-rated player', () => {
    const score = expectedScore(1400, 1200);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it('returns lower value for lower-rated player', () => {
    const score = expectedScore(1000, 1200);
    expect(score).toBeLessThan(0.5);
    expect(score).toBeGreaterThan(0);
  });

  it('A vs B and B vs A sum to 1', () => {
    const ab = expectedScore(1400, 1200);
    const ba = expectedScore(1200, 1400);
    expect(ab + ba).toBeCloseTo(1, 10);
  });

  it('200-point difference gives ~0.76 expected score', () => {
    const score = expectedScore(1400, 1200);
    expect(score).toBeCloseTo(0.76, 1);
  });
});

describe('updateEloRatings', () => {
  it('returns unchanged ratings for single player', () => {
    const result = updateEloRatings([{ name: 'bot1', elo: 1200 }]);
    expect(result).toEqual([{ name: 'bot1', elo: 1200, delta: 0 }]);
  });

  it('winner gains rating, loser loses rating in 2-player game', () => {
    const result = updateEloRatings([
      { name: 'winner', elo: 1200 },
      { name: 'loser', elo: 1200 },
    ]);

    const winner = result.find(r => r.name === 'winner');
    const loser = result.find(r => r.name === 'loser');

    expect(winner.delta).toBeGreaterThan(0);
    expect(loser.delta).toBeLessThan(0);
    // With equal ratings, delta should be ±16 (K/2)
    expect(winner.delta).toBe(16);
    expect(loser.delta).toBe(-16);
  });

  it('underdog gains more rating from an upset', () => {
    const result = updateEloRatings([
      { name: 'underdog', elo: 1000 }, // winner
      { name: 'favorite', elo: 1400 }, // loser
    ]);

    const underdog = result.find(r => r.name === 'underdog');
    expect(underdog.delta).toBeGreaterThan(16); // More than expected for equal-rated
  });

  it('favorite gains less from expected win', () => {
    const result = updateEloRatings([
      { name: 'favorite', elo: 1400 }, // winner
      { name: 'underdog', elo: 1000 }, // loser
    ]);

    const favorite = result.find(r => r.name === 'favorite');
    expect(favorite.delta).toBeLessThan(16); // Less than for equal-rated
    expect(favorite.delta).toBeGreaterThan(0);
  });

  it('handles multi-player games', () => {
    const result = updateEloRatings([
      { name: 'first', elo: 1200 },
      { name: 'second', elo: 1200 },
      { name: 'third', elo: 1200 },
      { name: 'fourth', elo: 1200 },
    ]);

    expect(result.length).toBe(4);
    // Winner should gain the most
    const first = result.find(r => r.name === 'first');
    const fourth = result.find(r => r.name === 'fourth');
    expect(first.delta).toBeGreaterThan(0);
    expect(fourth.delta).toBeLessThan(0);
  });

  it('total delta sums to approximately zero', () => {
    const result = updateEloRatings([
      { name: 'a', elo: 1200 },
      { name: 'b', elo: 1300 },
      { name: 'c', elo: 1100 },
    ]);

    const totalDelta = result.reduce((sum, r) => sum + r.delta, 0);
    // Due to rounding, allow small deviation
    expect(Math.abs(totalDelta)).toBeLessThanOrEqual(result.length);
  });

  it('uses custom K-factor', () => {
    const defaultK = updateEloRatings([
      { name: 'a', elo: 1200 },
      { name: 'b', elo: 1200 },
    ]);

    const doubleK = updateEloRatings(
      [
        { name: 'a', elo: 1200 },
        { name: 'b', elo: 1200 },
      ],
      64
    );

    expect(Math.abs(doubleK[0].delta)).toBeGreaterThan(Math.abs(defaultK[0].delta));
  });

  it('preserves player names in output', () => {
    const result = updateEloRatings([
      { name: 'alpha', elo: 1200 },
      { name: 'beta', elo: 1200 },
    ]);

    expect(result[0].name).toBe('alpha');
    expect(result[1].name).toBe('beta');
  });
});

describe('constants', () => {
  it('DEFAULT_RATING is 1200', () => {
    expect(DEFAULT_RATING).toBe(1200);
  });

  it('DEFAULT_K is 32', () => {
    expect(DEFAULT_K).toBe(32);
  });
});
