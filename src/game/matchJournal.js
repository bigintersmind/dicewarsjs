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
  /*
   * Same rule as finishMatchJournal below: a seat missing from the state being
   * recorded (a truncated or mocked state) costs this step's sample, not the
   * game. Statistics must never be the reason an attack seam throws.
   */
  const player = after?.players?.[journal.playerId];
  if (!player) return journal;
  const action = after.history.at(-1);
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
    /*
     * Sample once per completed turn OF THE PLAYER THIS JOURNAL IS ABOUT — not
     * once per player-turn. The chart is labelled "Your turns", and sampling
     * every seat's END_TURN put four samples on a four-player board where one
     * turn had passed, drawing a saw of the opponents' captures between the
     * player's own moves. Battles still contribute to the peaks, which is where
     * a mid-turn high is recorded.
     */
    points:
      ownTurn && action?.type === 'END_TURN'
        ? [...journal.points, { turn: after.turnsTaken, territories: player.territoryCount }]
        : journal.points,
  };
}

export function finishMatchJournal(journal, state) {
  if (!journal || journal.finished) return journal;
  /*
   * The final sample is skipped rather than thrown over when the seat is gone
   * from the state being finished against (a truncated or mocked terminal
   * state): a statistics helper must never be the reason a finished game fails
   * to reach the game-over screen. The journal still closes.
   */
  const player = state?.players?.[journal.playerId];
  return {
    ...journal,
    finished: true,
    won: state?.winner === journal.playerId,
    points: player
      ? [...journal.points, { turn: state.turnsTaken, territories: player.territoryCount }]
      : journal.points,
  };
}
