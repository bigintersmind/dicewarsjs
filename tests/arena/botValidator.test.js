import { validateBotSource, validateMove } from '../../src/arena/botValidator.js';
import { createBotState } from '../../src/arena/botState.js';
import { createGame } from '../../src/engine/GameRunner.js';

function createTestBotState(seed = 42) {
  const state = createGame({ seed, playerCount: 4 });
  const playerId = state.turnOrder[state.currentPlayerIndex];
  return createBotState(state, playerId);
}

describe('validateBotSource', () => {
  it('accepts valid function body', () => {
    const result = validateBotSource('return null;');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts multi-line bot source', () => {
    const source = `
      const myArea = state.myAreas.find(a => a.dice > 1);
      if (!myArea) return null;
      const target = myArea.neighbors[0];
      return { from: myArea.id, to: target };
    `;
    expect(validateBotSource(source).valid).toBe(true);
  });

  it('rejects empty string', () => {
    const result = validateBotSource('');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-empty/);
  });

  it('rejects non-string input', () => {
    expect(validateBotSource(null).valid).toBe(false);
    expect(validateBotSource(undefined).valid).toBe(false);
    expect(validateBotSource(42).valid).toBe(false);
  });

  it('rejects source with syntax errors', () => {
    const result = validateBotSource('return {{{');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Syntax error/);
  });

  it('rejects whitespace-only string', () => {
    expect(validateBotSource('   ').valid).toBe(false);
  });
});

describe('validateMove', () => {
  it('accepts null (end turn)', () => {
    const botState = createTestBotState();
    expect(validateMove(null, botState).valid).toBe(true);
  });

  it('accepts undefined (end turn)', () => {
    const botState = createTestBotState();
    expect(validateMove(undefined, botState).valid).toBe(true);
  });

  it('accepts a valid attack move', () => {
    const botState = createTestBotState();

    // Find a valid attack: owned territory with >1 dice attacking an enemy neighbor
    let validMove = null;
    for (const area of botState.myAreas) {
      if (area.dice <= 1) continue;
      for (const adjId of area.neighbors) {
        const adj = botState.allAreas.find(a => a.id === adjId);
        if (adj && adj.owner !== botState.myPlayer) {
          validMove = { from: area.id, to: adjId };
          break;
        }
      }
      if (validMove) break;
    }

    // There should be at least one valid move in a fresh game
    expect(validMove).not.toBeNull();
    const result = validateMove(validMove, botState);
    expect(result.valid).toBe(true);
  });

  it('rejects non-object move', () => {
    const botState = createTestBotState();
    expect(validateMove(42, botState).valid).toBe(false);
    expect(validateMove('attack', botState).valid).toBe(false);
    expect(validateMove(true, botState).valid).toBe(false);
  });

  it('rejects move with non-numeric from/to', () => {
    const botState = createTestBotState();
    expect(validateMove({ from: 'a', to: 'b' }, botState).valid).toBe(false);
  });

  it('rejects move with non-integer from/to', () => {
    const botState = createTestBotState();
    expect(validateMove({ from: 1.5, to: 2.5 }, botState).valid).toBe(false);
  });

  it('rejects move from nonexistent territory', () => {
    const botState = createTestBotState();
    const result = validateMove({ from: 999, to: 1 }, botState);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('rejects move from territory not owned by player', () => {
    const botState = createTestBotState();
    const enemyArea = botState.allAreas.find(a => a.owner !== botState.myPlayer);
    if (enemyArea) {
      const result = validateMove({ from: enemyArea.id, to: 1 }, botState);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not owned/);
    }
  });

  it('rejects move from territory with only 1 die', () => {
    const botState = createTestBotState();
    const weakArea = botState.myAreas.find(a => a.dice === 1);
    if (weakArea && weakArea.neighbors.length > 0) {
      const result = validateMove({ from: weakArea.id, to: weakArea.neighbors[0] }, botState);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/only 1 die/);
    }
  });

  it('rejects move attacking own territory', () => {
    const botState = createTestBotState();
    // Find two adjacent territories owned by the same player
    for (const area of botState.myAreas) {
      if (area.dice <= 1) continue;
      const friendlyNeighbor = area.neighbors.find(adjId =>
        botState.allAreas.find(a => a.id === adjId && a.owner === botState.myPlayer)
      );
      if (friendlyNeighbor) {
        const result = validateMove({ from: area.id, to: friendlyNeighbor }, botState);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/same player/);
        return;
      }
    }
    // If no two adjacent friendly territories exist, skip
  });

  it('rejects move to non-adjacent territory', () => {
    const botState = createTestBotState();
    const myArea = botState.myAreas.find(a => a.dice > 1);
    if (myArea) {
      // Find an enemy territory that is NOT adjacent
      const nonAdjacentEnemy = botState.allAreas.find(
        a => a.owner !== botState.myPlayer && !myArea.neighbors.includes(a.id)
      );
      if (nonAdjacentEnemy) {
        const result = validateMove({ from: myArea.id, to: nonAdjacentEnemy.id }, botState);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/not adjacent/);
      }
    }
  });

  it('rejects move to nonexistent territory', () => {
    const botState = createTestBotState();
    const myArea = botState.myAreas.find(a => a.dice > 1);
    if (myArea) {
      const result = validateMove({ from: myArea.id, to: 999 }, botState);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/does not exist/);
    }
  });
});
