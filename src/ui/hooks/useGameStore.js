/**
 * Preact hook for subscribing to the GameStore.
 *
 * @module ui/hooks/useGameStore
 */

import { useState, useEffect, useRef } from 'preact/hooks';

/**
 * Subscribe a Preact component to the GameStore.
 *
 * Without a selector the full store state is returned (component re-renders
 * on every setState).  With a selector the component only re-renders when
 * the selected value changes (strict equality check).
 *
 * @template T
 * @param {Object} store - GameStore instance (getState, subscribe)
 * @param {((s: import('../../store/GameStore.js').StoreState) => T)} [selector]
 * @returns {T}
 */
export function useGameStore(store, selector) {
  const pick = selector || (s => s);
  const [value, setValue] = useState(() => pick(store.getState()));
  const selectorRef = useRef(pick);
  selectorRef.current = pick;

  useEffect(() => {
    // Sync in case state changed between render and effect
    const current = selectorRef.current(store.getState());
    setValue(prev => (prev === current ? prev : current));

    return store.subscribe(next => {
      const selected = selectorRef.current(next);
      setValue(prev => (prev === selected ? prev : selected));
    });
  }, [store]);

  return value;
}
