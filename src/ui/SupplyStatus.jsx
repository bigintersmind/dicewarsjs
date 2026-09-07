import { useGameStore } from './hooks/useGameStore.js';
import { formatDailyDate } from '../game/dailyChallenge.js';

const CSS = `
.dw-supply { position: absolute; top: 1rem; left: 50%; transform: translateX(-50%);
  width: min(420px, calc(100% - 100px)); padding: .7rem 1rem; pointer-events: none;
  color: var(--ui-text); background: var(--ui-bg); border: 1px solid var(--ui-border);
  border-radius: 8px; font-family: Roboto, sans-serif; }
.dw-supply-heading { display: flex; justify-content: space-between; gap: .4rem;
  font-size: .65rem; letter-spacing: .1em; text-transform: uppercase; color: var(--ui-text-muted); }
.dw-supply dl { display: flex; justify-content: space-between; gap: .7rem; margin: .45rem 0 0; }
.dw-supply dl div { display: flex; align-items: baseline; gap: .35rem; }
.dw-supply dt { font-size: .72rem; color: var(--ui-text-muted); }
.dw-supply dd { margin: 0; font: 1.25rem Anton, sans-serif; font-variant-numeric: tabular-nums; }
.dw-supply p { margin: .45rem 0 0; font-size: .7rem; line-height: 1.4; color: var(--ui-text-muted); }
@media (max-width: 440px) {
  .dw-supply { padding: .65rem .7rem; }
  .dw-supply dl div { flex-direction: column-reverse; gap: 0; }
}
@media (max-height: 520px) {
  .dw-supply { top: .5rem; padding: .4rem .75rem; display: flex; align-items: center;
    gap: 1rem; width: max-content; max-width: calc(100% - 100px); }
  .dw-supply p { display: none; }
  .dw-supply-heading { gap: .75rem; }
  .dw-supply dl { margin: 0; gap: 1rem; }
  .dw-supply dl div { flex-direction: row; gap: .35rem; }
  .dw-supply dd { font-size: 1rem; }
}
`;

export function SupplyStatus({ store }) {
  const state = useGameStore(store, s => s.gameState);
  const human = useGameStore(store, s => s.humanPlayerIndex);
  const daily = useGameStore(store, s => s.dailyChallenge);
  const player = state?.players[human];
  if (human === null || !player || player.eliminated) return null;
  return (
    <aside className="dw-supply" aria-label="Your supply">
      <style>{CSS}</style>
      <div className="dw-supply-heading">
        <span>{daily ? `Daily · ${formatDailyDate(daily.date)}` : 'Your supply'}</span>
        <span>Round {(state.turnNumber ?? 0) + 1}</span>
      </div>
      <dl>
        <div>
          <dt>Land</dt>
          <dd>{player.territoryCount}</dd>
        </div>
        <div>
          <dt>Income / turn</dt>
          <dd>+{player.largestGroup}</dd>
        </div>
        <div>
          <dt>In reserve</dt>
          <dd>{player.stock}</dd>
        </div>
      </dl>
      <p>Your largest connected group earns {player.largestGroup} dice at the end of your turn.</p>
    </aside>
  );
}
