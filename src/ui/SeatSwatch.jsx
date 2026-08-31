/**
 * Seat Swatch
 *
 * A seat's board color as a small square beside the words, never as the words
 * themselves. Half the player palette is a bright pastel — yellow, lime, cyan —
 * and set as text on the light theme's near-white panels those measured about
 * 1:1 (#220). The same color as a filled chip is fine: a block of color has no
 * thin strokes to lose. So status lines name the bot in `--ui-text` and let the
 * swatch carry the seat, which is what tells two seats running the same bot
 * apart.
 *
 * Sized in `em` so one component fits both the 19px "is thinking..." line and
 * the 24px game-over subtitle, and hidden from assistive tech: the color is a
 * second copy of an identity the name beside it already spells out.
 *
 * @module ui/SeatSwatch
 */

const STYLE = {
  display: 'inline-block',
  width: '0.8em',
  height: '0.8em',
  marginRight: '0.4em',
  /* Baseline alignment already lands a 0.8em box near the cap-height centre of
     the text beside it; the small drop puts it exactly there. */
  verticalAlign: '-0.05em',
  borderRadius: '3px',
  /* A rim so a pale seat keeps an edge on a pale panel and a dark one keeps an
     edge on the dark board — the color-blind palette's Black seat would
     otherwise dissolve into the dark theme entirely. */
  border: '1px solid var(--ui-border)',
  /* No-op on its own, but it survives being dropped into a flex row (the way
     the HUD chips lay their swatches out) without being squeezed. */
  flexShrink: 0,
};

/**
 * @param {Object} props
 * @param {string} props.color - The seat's board color, as a CSS color string
 */
export function SeatSwatch({ color }) {
  return <span aria-hidden="true" style={{ ...STYLE, background: color }} />;
}
