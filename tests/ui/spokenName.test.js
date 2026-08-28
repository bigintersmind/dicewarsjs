/**
 * spokenName tests
 *
 * The one rule two channels share (#211): the live region and the board's
 * territory buttons both name a seat with this, so a lineup running the same
 * bot twice is told apart by the seat number rather than by the color neither
 * channel has.
 */

import { spokenName, diceCount } from '../../src/ui/spokenName.js';

describe('spokenName', () => {
  it('speaks a name unique in the lineup bare', () => {
    expect(spokenName(['You', 'Conqueror', 'Blitz'], 1)).toBe('Conqueror');
  });

  /*
   * The trailing comma comes with the repeated form on purpose: it is what lets
   * a caller run the name straight into whatever follows ("...owned by Balanced
   * AI, player 3, 2 dice").
   */
  it('adds the seat number when the lineup repeats the name', () => {
    expect(spokenName(['You', 'Balanced AI', 'Balanced AI'], 2)).toBe('Balanced AI, player 3,');
  });

  it('falls back to the seat number when no names are recorded', () => {
    expect(spokenName([], 1)).toBe('Player 2');
    expect(spokenName(undefined, 0)).toBe('Player 1');
  });

  /*
   * Two unnamed seats both fall back, and the fallbacks differ by seat, so
   * neither counts as a repeat — the bare form is already unambiguous.
   */
  it('does not treat two distinct fallback names as a repeat', () => {
    expect(spokenName(['You'], 2)).toBe('Player 3');
  });
});

describe('diceCount', () => {
  // The other half of the shared contract: the buttons, the selection prompt and
  // the battle lines all count a territory's dice with this, so no two of them
  // can disagree about "1 die".
  it('says "1 die" for one and "N dice" for the rest', () => {
    expect(diceCount(1)).toBe('1 die');
    expect(diceCount(4)).toBe('4 dice');
  });
});
