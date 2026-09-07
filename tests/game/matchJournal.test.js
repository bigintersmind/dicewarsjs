import {
  createGame,
  applyAction,
  getValidMoves,
  findLargestConnectedGroup,
} from '../../src/engine/index.js';
import {
  createMatchJournal,
  recordMatchStep,
  finishMatchJournal,
} from '../../src/game/matchJournal.js';

describe('Human campaign journal', () => {
  it('agrees with an independent action tally through a real engine match', () => {
    let state = createGame({
      playerCount: 3,
      seed: 412,
      mapWidth: 20,
      mapHeight: 24,
      maxAreas: 20,
    });
    const initial = state;
    let journal = createMatchJournal(state, 0);
    const originalJournal = structuredClone(journal);
    const humanTurns = new Set();
    let attacks = 0;
    let wins = 0;
    let peakLand = state.players[0].territoryCount;
    let peakIncome = state.players[0].largestGroup;
    for (let i = 0; i < 2000 && state.phase !== 'gameOver' && !state.players[0].eliminated; i++) {
      const moves = getValidMoves(state);
      const move =
        moves.find(m => m.attackerDice > m.defenderDice) ?? moves.find(m => m.attackerDice === 8);
      const before = state;
      const actor = before.turnOrder[before.currentPlayerIndex];
      state = applyAction(
        state,
        move ? { type: 'ATTACK', from: move.from, to: move.to } : { type: 'END_TURN' }
      );
      if (actor === 0) {
        humanTurns.add(before.turnsTaken);
        if (move) {
          attacks++;
          if (state.areas[move.to].owner === 0) wins++;
        }
      }
      peakLand = Math.max(peakLand, state.players[0].territoryCount);
      peakIncome = Math.max(peakIncome, findLargestConnectedGroup(state.areas, 0));
      journal = recordMatchStep(journal, before, state);
    }
    expect(attacks).toBeGreaterThan(0);
    expect(wins).toBeGreaterThan(0);
    expect(journal).toMatchObject({
      turns: humanTurns.size,
      attacks,
      captures: wins,
      peakTerritories: peakLand,
      peakIncome,
    });
    const finished = finishMatchJournal(journal, state);
    expect(finished.points[0]).toEqual({ turn: 0, territories: initial.players[0].territoryCount });
    expect(finished.points.at(-1).territories).toBe(state.players[0].territoryCount);
    expect(finishMatchJournal(finished, state)).toBe(finished);
    expect(recordMatchStep(finished, initial, state)).toBe(finished);
    expect(createMatchJournal(initial, 0)).toEqual(originalJournal);
  });

  it('records a loss before the human ever acts as zero turns and freezes it for spectating', () => {
    const initial = createGame({ playerCount: 2, seed: 21 });
    const journal = createMatchJournal(initial, 0);
    const terminal = {
      ...initial,
      players: initial.players.map(p => (p.id === 0 ? { ...p, territoryCount: 0 } : p)),
      winner: 1,
    };
    const finished = finishMatchJournal(journal, terminal);
    expect(finished).toMatchObject({ turns: 0, won: false, finished: true });
    expect(finished.points.at(-1).territories).toBe(0);
    expect(finishMatchJournal(finished, initial)).toBe(finished);
    expect(createMatchJournal(initial, null)).toBeNull();
    expect(recordMatchStep(null, initial, terminal)).toBeNull();
  });
});
