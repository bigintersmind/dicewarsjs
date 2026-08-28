/**
 * Screen Reader Announcer
 *
 * Renders a visually hidden ARIA live region that announces
 * game events to screen readers.
 *
 * App mounts exactly one of these, outside its screen switch, so the region is
 * one stable node for the whole session (#211 item 9) — see the render site
 * there for why. The hook below therefore runs on every screen and decides for
 * itself when there is a game to talk about.
 *
 * @module ui/ScreenReaderAnnouncer
 */

import { useAnnouncer } from './hooks/useAnnouncer.js';

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 */
export function ScreenReaderAnnouncer({ store }) {
  const announcement = useAnnouncer(store);

  /*
   * role="status", not "log": the region carries one current line, replaced in
   * place, which is advisory status rather than an append-only history of lines
   * (#211 item 11). Nothing about the announcing changes with the swap, because
   * the explicit aria-live / aria-atomic PIN the behaviour either way — polite
   * and atomic happen to be `status`'s own implicit values, and were what
   * overrode `log`'s implicit `aria-atomic="false"` before. The role is just
   * what the region honestly is, for anything that reads the role alone.
   */
  return (
    <div aria-live="polite" aria-atomic="true" class="sr-only" role="status">
      {announcement}
    </div>
  );
}
