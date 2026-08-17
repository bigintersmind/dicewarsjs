import { describe, it, expect, vi } from 'vitest';
import { createGameStore, playerName, HUMAN_PLAYER_NAME } from '../../src/store/GameStore.js';
import { AI_STRATEGIES } from '../../src/ai/aiConfig.js';
import { DIFFICULTY_MODES } from '../../src/ai/difficultyModes.js';

describe('GameStore', () => {
  it('creates with default state', () => {
    const store = createGameStore();
    const s = store.getState();
    expect(s.screen).toBe('title');
    expect(s.gameState).toBeNull();
    expect(s.humanPlayerIndex).toBe(0);
    expect(s.aiSpeed).toBe(1);
    expect(s.soundEnabled).toBe(true);
    expect(s.config.playerCount).toBe(7);
  });

  it('accepts initial overrides', () => {
    const store = createGameStore({ screen: 'playing', aiSpeed: 3 });
    expect(store.getState().screen).toBe('playing');
    expect(store.getState().aiSpeed).toBe(3);
    // defaults still present for non-overridden keys
    expect(store.getState().soundEnabled).toBe(true);
  });

  it('setState shallow-merges and notifies subscribers', () => {
    const store = createGameStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState({ screen: 'playing' });

    expect(store.getState().screen).toBe('playing');
    expect(listener).toHaveBeenCalledTimes(1);
    const [next, prev] = listener.mock.calls[0];
    expect(next.screen).toBe('playing');
    expect(prev.screen).toBe('title');
  });

  it('notifies multiple subscribers', () => {
    const store = createGameStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);

    store.setState({ aiSpeed: 5 });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const store = createGameStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.setState({ screen: 'mapPreview' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    store.setState({ screen: 'playing' });
    expect(listener).toHaveBeenCalledTimes(1); // no additional call
  });

  it('select reads a derived value', () => {
    const store = createGameStore({ aiSpeed: 4 });
    const speed = store.select(s => s.aiSpeed);
    expect(speed).toBe(4);
  });

  it('preserves unrelated state on partial update', () => {
    const store = createGameStore({ soundEnabled: false });
    store.setState({ screen: 'playing' });
    expect(store.getState().soundEnabled).toBe(false);
    expect(store.getState().screen).toBe('playing');
  });

  it('can store gameState from engine', () => {
    const store = createGameStore();
    const fakeGameState = { areas: [], players: [], phase: 'playing' };
    store.setState({ gameState: fakeGameState });
    expect(store.getState().gameState).toBe(fakeGameState);
  });

  it('subscriber survives a throw and continues receiving updates', () => {
    const store = createGameStore();
    let callCount = 0;
    const listener = vi.fn(() => {
      callCount++;
      if (callCount === 1) throw new Error('transient error');
    });

    store.subscribe(listener);

    // First call throws
    store.setState({ screen: 'playing' });
    expect(listener).toHaveBeenCalledTimes(1);

    // Subscriber should still receive subsequent updates
    store.setState({ screen: 'gameOver' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('includes error field in default state', () => {
    const store = createGameStore();
    expect(store.getState().error).toBeNull();
  });

  it('handles rapid successive updates', () => {
    const store = createGameStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState({ selectedFrom: 1 });
    store.setState({ selectedTo: 5 });
    store.setState({ animationPhase: 'battle' });

    expect(listener).toHaveBeenCalledTimes(3);
    const s = store.getState();
    expect(s.selectedFrom).toBe(1);
    expect(s.selectedTo).toBe(5);
    expect(s.animationPhase).toBe('battle');
  });

  describe('defaults', () => {
    it('defaults the battle lineup to the Standard difficulty preset (#167)', () => {
      const s = createGameStore().getState();
      // Pinned literally so a difficultyModes.js edit can't silently change the
      // shipped default; the by-construction assertion ties it to the preset.
      expect(s.config.aiAssignments).toEqual([null, ...Array(7).fill('ai_default')]);
      expect(s.config.aiAssignments).toEqual(DIFFICULTY_MODES.standard.lineup);
      // Fresh copy, not a shared reference — setState/UI edits must not
      // mutate the preset.
      expect(s.config.aiAssignments).not.toBe(DIFFICULTY_MODES.standard.lineup);
    });

    it("defaults difficulty to 'standard' (#167)", () => {
      expect(createGameStore().getState().config.difficulty).toBe('standard');
    });

    it('assigns only ids that resolve to un-hidden picker entries', () => {
      const s = createGameStore().getState();
      for (const id of s.config.aiAssignments.slice(1)) {
        expect(AI_STRATEGIES[id]).toBeDefined();
        expect(AI_STRATEGIES[id].hidden).toBeUndefined();
      }
    });

    it('starts with no lineup recorded (playerNames empty)', () => {
      expect(createGameStore().getState().playerNames).toEqual([]);
    });
  });

  // The seat-label helper the in-game text goes through ("<name> is thinking...").
  describe('playerName', () => {
    it('returns the recorded name for the seat', () => {
      expect(playerName(['You', 'Conqueror', 'Blitz'], 2)).toBe('Blitz');
      expect(playerName([HUMAN_PLAYER_NAME, 'Conqueror'], 0)).toBe('You');
    });

    it('falls back to the 1-based seat number when the lineup was never recorded', () => {
      expect(playerName([], 2)).toBe('Player 3');
      expect(playerName(undefined, 0)).toBe('Player 1');
    });

    it('falls back for an index past the recorded lineup', () => {
      expect(playerName(['You', 'Conqueror'], 5)).toBe('Player 6');
    });
  });
});
