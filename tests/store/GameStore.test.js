import { describe, it, expect, vi } from 'vitest';
import { createGameStore } from '../../src/store/GameStore.js';

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
});
