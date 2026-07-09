import { reportBotErrors, ERROR_FRACTION_THRESHOLD } from '../../src/arena/botErrorReport.js';

describe('reportBotErrors', () => {
  it('flags a bot whose per-turn error rate exceeds the threshold and reports the fraction', () => {
    const warned = [];
    const flagged = reportBotErrors(
      [
        { name: 'healthy', errors: 0, turns: 100, attacks: 500 },
        { name: 'broken', errors: 90, turns: 100, attacks: 10 },
      ],
      { warn: msg => warned.push(msg) }
    );

    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('broken');
    expect(flagged[0].errorFraction).toBeCloseTo(0.9, 5);

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('broken');
    expect(warned[0]).toContain('errored on 90 of 100 turn(s)');
    expect(warned[0]).toContain('90.0%');
  });

  it('does not flag healthy bots (zero errors)', () => {
    const warned = [];
    const flagged = reportBotErrors(
      [
        { name: 'a', errors: 0, turns: 50, attacks: 250 },
        { name: 'b', errors: 0, turns: 30, attacks: 90 },
      ],
      { warn: msg => warned.push(msg) }
    );

    expect(flagged).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('flags a half-broken bot the old errors/(errors+attacks) metric missed (#92 item 4)', () => {
    // The worked example from #92: 25 error-turns among 40 turns, but ~2.5 attacks per healthy
    // turn → 100 attacks. The old formula scored 25/(25+100)=0.20 and left it UNFLAGGED despite
    // a 62.5% turn-error rate. The per-turn metric reads the true rate: 25/40 = 0.625 → flagged.
    const flagged = reportBotErrors([{ name: 'half', errors: 25, turns: 40, attacks: 100 }], {
      warn: () => {},
    });

    expect(flagged).toHaveLength(1);
    expect(flagged[0].errorFraction).toBeCloseTo(0.625, 5);
    // Sanity: the discarded old metric would have scored this well under 0.5.
    expect(25 / (25 + 100)).toBeLessThan(ERROR_FRACTION_THRESHOLD);
  });

  it('flags a bot that errors on 100% of its turns (the #52 BC failure mode)', () => {
    const flagged = reportBotErrors([{ name: 'allErrors', errors: 40, turns: 40, attacks: 0 }], {
      warn: () => {},
    });

    expect(flagged).toHaveLength(1);
    expect(flagged[0].errorFraction).toBe(1);
  });

  it('skips a bot that never acted (no turns, no attacks) — division-by-zero guard', () => {
    const warned = [];
    const flagged = reportBotErrors(
      [{ name: 'pure-pass', errors: 0, turns: 0, attacks: 0, invalidMoves: 0, maxMovesHit: 0 }],
      { warn: msg => warned.push(msg) }
    );

    expect(flagged).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('skips a voluntary all-STOP bot that took turns but never attacked or errored', () => {
    // turns > 0 but it stopped every turn: no errors, no invalid moves, no attacks. Degenerate
    // (it never plays) but not broken — errors/turns is 0 and there is nothing to flag.
    const flagged = reportBotErrors(
      [{ name: 'passer', errors: 0, turns: 30, attacks: 0, invalidMoves: 0 }],
      { warn: () => {} }
    );
    expect(flagged).toEqual([]);
  });

  it('flags a bot that only ever submits invalid moves — never lands an attack (#53)', () => {
    // A mis-registered bot (wrong coordinate space) returns an illegal move every turn:
    // invalidMoves climbs while errors and attacks stay 0, so the per-turn error rate reads 0.
    // The never-landed-a-valid-attack branch catches it before the rate; without it this
    // masquerades as a clean low-ELO loss.
    const warned = [];
    const flagged = reportBotErrors(
      [
        {
          name: 'misregistered',
          errors: 0,
          turns: 30,
          attacks: 0,
          invalidMoves: 30,
          maxMovesHit: 0,
        },
      ],
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
    // Deliberate scope: the never-landed-an-attack rescue only fires when attacks === 0. A bot
    // that lands real attacks (attacks > 0) is measured purely on the per-turn error rate, so a
    // buggy-but-functioning bot with many invalid moves but real attacks is not flagged here.
    const flagged = reportBotErrors(
      [{ name: 'buggy', errors: 0, turns: 20, attacks: 50, invalidMoves: 200 }],
      { warn: () => {} }
    );
    expect(flagged).toEqual([]);
  });

  it('does not flag a bot exactly at the threshold (strictly greater than)', () => {
    // errors/turns === 0.5 exactly, which is not > 0.5
    const flagged = reportBotErrors([{ name: 'borderline', errors: 20, turns: 40, attacks: 10 }], {
      warn: () => {},
    });
    expect(flagged).toEqual([]);
  });

  it('does not divide by zero when attacks are present but turns are missing', () => {
    // Malformed totals (attacks without a turn count) must never yield NaN/Infinity: the bot
    // demonstrably played (it attacked), so absent turn data is graded as unflaggable, not broken.
    const flagged = reportBotErrors([{ name: 'noturns', errors: 5, attacks: 10 }], {
      warn: () => {},
    });
    expect(flagged).toEqual([]);
  });

  it('respects a custom threshold', () => {
    const warned = [];
    const flagged = reportBotErrors([{ name: 'mild', errors: 20, turns: 100, attacks: 80 }], {
      threshold: 0.1,
      warn: msg => warned.push(msg),
    });

    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('mild');
    expect(flagged[0].errorFraction).toBeCloseTo(0.2, 5);
    expect(warned).toHaveLength(1);
  });

  it('uses the provided label in the warning', () => {
    const warned = [];
    reportBotErrors([{ name: 'broken', errors: 10, turns: 10, attacks: 0 }], {
      label: '[Tournament]',
      warn: msg => warned.push(msg),
    });

    expect(warned[0]).toContain('[Tournament]');
  });

  it('sorts flagged bots by error fraction descending', () => {
    const flagged = reportBotErrors(
      [
        { name: 'worst', errors: 99, turns: 100, attacks: 5 },
        { name: 'mild', errors: 60, turns: 100, attacks: 5 },
        { name: 'mid', errors: 80, turns: 100, attacks: 5 },
      ],
      { warn: () => {} }
    );

    expect(flagged.map(f => f.name)).toEqual(['worst', 'mid', 'mild']);
  });

  it('defaults to console.warn when no warn sink is provided', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportBotErrors([{ name: 'broken', errors: 10, turns: 10, attacks: 0 }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('broken'));
    warnSpy.mockRestore();
  });

  it('treats missing numeric fields as zero (errors-only totals → masquerade at 1.0)', () => {
    // attacks/turns/invalidMoves undefined → 0. attacks === 0 with errors > 0 is the
    // never-landed-an-attack masquerade → fraction 1.
    const flagged = reportBotErrors([{ name: 'sparse', errors: 5 }], { warn: () => {} });
    expect(flagged).toHaveLength(1);
    expect(flagged[0].errorFraction).toBe(1);
  });

  it('exposes a default threshold of 0.5', () => {
    expect(ERROR_FRACTION_THRESHOLD).toBe(0.5);
  });
});
