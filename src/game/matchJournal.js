/** Small, immutable human-match summaries. Reads resolved actions; consumes no RNG. */
export function createMatchJournal(state, playerId) {
  const player = state.players[playerId];
  if (!player) return null;
  return {
    playerId,
    turns: 0,
    lastTurn: null,
    attacks: 0,
    captures: 0,
    peakTerritories: player.territoryCount,
    peakIncome: player.largestGroup,
    points: [{ turn: 0, territories: player.territoryCount }],
    finished: false,
  };
}

export function recordMatchStep(journal, before, after) {
  if (!journal || journal.finished) return journal;
  const action = after.history.at(-1);
  const player = after.players[journal.playerId];
  const ownTurn = before.turnOrder[before.currentPlayerIndex] === journal.playerId;
  const attack = ownTurn && action?.type === 'ATTACK';
  const newTurn = ownTurn && journal.lastTurn !== before.turnsTaken;
  return {
    ...journal,
    turns: journal.turns + Number(newTurn),
    lastTurn: ownTurn ? before.turnsTaken : journal.lastTurn,
    attacks: journal.attacks + Number(attack),
    captures: journal.captures + Number(attack && action.result.success),
    peakTerritories: Math.max(journal.peakTerritories, player.territoryCount),
    peakIncome: Math.max(journal.peakIncome, player.largestGroup),
    // Sample once per completed player-turn; battles still contribute to peaks.
    points:
      action?.type === 'END_TURN'
        ? [...journal.points, { turn: after.turnsTaken, territories: player.territoryCount }]
        : journal.points,
  };
}

export function finishMatchJournal(journal, state) {
  if (!journal || journal.finished) return journal;
  return {
    ...journal,
    finished: true,
    won: state.winner === journal.playerId,
    points: [
      ...journal.points,
      { turn: state.turnsTaken, territories: state.players[journal.playerId].territoryCount },
    ],
  };
}
