/**
 * Screen Reader Announcer
 *
 * Renders a visually hidden ARIA live region that announces
 * game events to screen readers.
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

  return (
    <div aria-live="assertive" aria-atomic="true" class="sr-only" role="status">
      {announcement}
    </div>
  );
}
