import { reportBotErrors, ERROR_FRACTION_THRESHOLD } from '../../src/arena/botErrorReport.js';

describe('reportBotErrors', () => {
  it('flags a bot that errors on most of its turns and reports the fraction', () => {
    const warned = [];
    const flagged = reportBotErrors(
      [
        { name: 'healthy', errors: 0, attacks: 100 },
        { name: 'broken', errors: 90, attacks: 10 },
      ],
      { warn: msg => warned.push(msg) }
    );

    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('broken');
    expect(flagged[0].errorFraction).toBeCloseTo(0.9, 5);

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('broken');
    expect(warned[0]).toContain('90.0%');
  });

  it('does not flag healthy bots (zero errors)', () => {
    const warned = [];
    const flagged = reportBotErrors(
      [
        { name: 'a', errors: 0, attacks: 50 },
        { name: 'b', errors: 0, attacks: 30 },
      ],
      { warn: msg => warned.push(msg) }
    );

    expect(flagged).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('flags a bot that errors on 100% of its turns (the #52 BC failure mode)', () => {
    const flagged = reportBotErrors([{ name: 'allErrors', errors: 40, attacks: 0 }], {
      warn: () => {},
    });

    expect(flagged).toHaveLength(1);
    expect(flagged[0].errorFraction).toBe(1);
  });

  it('skips a bot that never acted (no errors, no attacks) — division-by-zero guard', () => {
    const warned = [];
    const flagged = reportBotErrors(
      [{ name: 'pure-pass', errors: 0, attacks: 0, invalidMoves: 0, maxMovesHit: 0 }],
      { warn: msg => warned.push(msg) }
    );

    expect(flagged).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('flags a bot that only ever submits invalid moves — never lands an attack (#53)', () => {
    // A mis-registered bot (wrong coordinate space) returns an illegal move every turn:
    // invalidMoves climbs while errors and attacks stay 0. The errors fraction is undefined
    // (denom 0), so without the invalid-move guard this masquerades as a clean low-ELO loss.
    const warned = [];
    const flagged = reportBotErrors(
      [{ name: 'misregistered', errors: 0, attacks: 0, invalidMoves: 30, maxMovesHit: 0 }],
      { warn: msg => warned.push(msg) }
    );

    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('misregistered');
    expect(flagged[0].errorFraction).toBe(1);

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('misregistered');
    expect(warned[0]).toContain('30 invalid move(s)');
    expect(warned[0]).toContain('100.0%');
  });

  it('does NOT fold invalid moves into the fraction once a bot lands real attacks', () => {
    // Deliberate scope: the invalid-move rescue only covers the never-landed-an-attack case.
    // A bot that attacks (denom > 0) is measured purely on the spec errors fraction, so a
    // buggy-but-functioning bot with many invalid moves but real attacks is not flagged here.
    const flagged = reportBotErrors(
      [{ name: 'buggy', errors: 0, attacks: 50, invalidMoves: 200 }],
      {
        warn: () => {},
      }
    );
    expect(flagged).toEqual([]);
  });

  it('does not flag a bot exactly at the threshold (strictly greater than)', () => {
    // errors/(errors+attacks) === 0.5 exactly, which is not > 0.5
    const flagged = reportBotErrors([{ name: 'borderline', errors: 50, attacks: 50 }], {
      warn: () => {},
    });
    expect(flagged).toEqual([]);
  });

  it('respects a custom threshold', () => {
    const warned = [];
    const flagged = reportBotErrors([{ name: 'mild', errors: 20, attacks: 80 }], {
      threshold: 0.1,
      warn: msg => warned.push(msg),
    });

    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('mild');
    expect(warned).toHaveLength(1);
  });

  it('uses the provided label in the warning', () => {
    const warned = [];
    reportBotErrors([{ name: 'broken', errors: 10, attacks: 0 }], {
      label: '[Tournament]',
      warn: msg => warned.push(msg),
    });

    expect(warned[0]).toContain('[Tournament]');
  });

  it('sorts flagged bots by error fraction descending', () => {
    const flagged = reportBotErrors(
      [
        { name: 'worst', errors: 99, attacks: 1 },
        { name: 'mild', errors: 6, attacks: 4 },
        { name: 'mid', errors: 8, attacks: 2 },
      ],
      { warn: () => {} }
    );

    expect(flagged.map(f => f.name)).toEqual(['worst', 'mid', 'mild']);
  });

  it('defaults to console.warn when no warn sink is provided', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportBotErrors([{ name: 'broken', errors: 10, attacks: 0 }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('broken'));
    warnSpy.mockRestore();
  });

  it('treats missing numeric fields as zero', () => {
    const flagged = reportBotErrors([{ name: 'sparse', errors: 5 }], { warn: () => {} });
    // attacks undefined → 0; fraction 5/5 = 1
    expect(flagged).toHaveLength(1);
    expect(flagged[0].errorFraction).toBe(1);
  });

  it('exposes a default threshold of 0.5', () => {
    expect(ERROR_FRACTION_THRESHOLD).toBe(0.5);
  });
});
