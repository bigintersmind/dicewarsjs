/**
 * Supply Status
 *
 * The in-game panel above the board: the three numbers a player has to hold in
 * their head to plan a turn — how much land they hold, how many reinforcement
 * dice their largest connected group will earn them, and what is waiting in the
 * stockpile.
 *
 * Its words are the rules card's words (RulesModal's "Reinforce" section and
 * docs/GAME_RULES.md): "largest connected group", "reinforcement dice",
 * "stockpile". The panel used to say "Income / turn" and "In reserve", terms
 * that appear nowhere else in the game — one vocabulary across the panel, the
 * match report and the rules, or the panel teaches a language the rules do not
 * speak.
 *
 * Two contracts with the layers around it:
 *
 * - It paints `--ui-panel-bg`, the OPAQUE panel token, not `--ui-bg`. What a
 *   translucent panel really carries here is the territory underneath, and
 *   measured over the brightest seats its muted labels ran 2.6:1 in the dark
 *   theme (see themes.js).
 * - It publishes its measured height as `--dw-supply-panel-height`, the way
 *   GameHUD publishes its bar height, and GameRenderer reserves that band at
 *   the top of the board. Without it a Large map on a short window is scaled to
 *   the full window height and its top rows sit under this panel.
 *
 * @module ui/SupplyStatus
 */

import { useLayoutEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { formatDailyDate } from '../game/dailyChallenge.js';
import { SUPPLY_PANEL_HEIGHT_VAR } from '../renderer/constants.js';

const SUPPLY_CSS = `
.dw-supply { position: absolute; top: 1rem; left: 50%; transform: translateX(-50%);
  width: min(420px, calc(100% - 100px)); padding: .7rem 1rem; pointer-events: none;
  color: var(--ui-text); background: var(--ui-panel-bg); border: 1px solid var(--ui-border);
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

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 */
export function SupplyStatus({ store }) {
  const state = useGameStore(store, s => s.gameState);
  const human = useGameStore(store, s => s.humanPlayerIndex);
  const daily = useGameStore(store, s => s.dailyChallenge);
  const panelRef = useRef(null);
  const player = state?.players[human];
  const showing = human !== null && Boolean(player) && !player?.eliminated;

  /*
   * Publish the panel's MEASURED height on the document root, exactly as
   * GameHUD publishes its bar (see the long note there — same reasoning, same
   * caveats): measured rather than declared because the panel reflows under
   * 440px and again under 520px tall, an inline property on the root outranks
   * any stylesheet rule so GameRenderer needs no special case, and the
   * dispatched 'resize' is how the renderer hears about it at all.
   *
   * The removal on unmount is what withdraws the reservation for every screen
   * that has no panel — the board fills the window again the moment the game
   * ends. Singleton writer, like the HUD's: exactly one SupplyStatus is
   * mounted, on the playing screen.
   *
   * Above the early return so the hook order is fixed whether or not there is a
   * seat to show; `showing` is in the deps so the property appears and
   * disappears with the panel (a spectator takeover unmounts it mid-game).
   */
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return undefined;

    const root = document.documentElement;
    const publish = () => {
      // The panel is `position: absolute` at `top: 1rem`, so what the board has
      // to clear is the panel plus the gap above it, not the panel alone.
      const box = el.getBoundingClientRect();
      const height = Math.ceil(box.bottom);
      // A zero height is a panel that has not been laid out (jsdom, a hidden
      // subtree, a browser mid-font-swap): reserving nothing is what an absent
      // property already means, so publish nothing rather than a bogus 0px.
      if (height <= 0) return;
      const next = `${height}px`;
      if (root.style.getPropertyValue(SUPPLY_PANEL_HEIGHT_VAR) === next) return;
      root.style.setProperty(SUPPLY_PANEL_HEIGHT_VAR, next);
      window.dispatchEvent(new Event('resize'));
    };

    publish();

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    if (observer) observer.observe(el);

    return () => {
      if (observer) observer.disconnect();
      root.style.removeProperty(SUPPLY_PANEL_HEIGHT_VAR);
      window.dispatchEvent(new Event('resize'));
    };
  }, [showing]);

  if (!showing) return null;
  return (
    <aside className="dw-supply" aria-label="Your supply" ref={panelRef}>
      <style>{SUPPLY_CSS}</style>
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
          <dt>Reinforcements</dt>
          <dd>+{player.largestGroup}</dd>
        </div>
        <div>
          <dt>Stockpile</dt>
          <dd>{player.stock}</dd>
        </div>
      </dl>
      <p>
        Your largest connected group earns {player.largestGroup} reinforcement dice at the end of
        your turn.
      </p>
    </aside>
  );
}
