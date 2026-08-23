/**
 * Rules Diagrams
 *
 * The five inline SVG figures that ride alongside the copy in RulesModal — a
 * picture of each rule so a playtester can skim the modal without reading it
 * end to end.
 *
 * Everything is line art in `currentColor` plus `var(--ui-accent)` for "yours",
 * so the figures re-theme with the rest of the UI instead of carrying baked-in
 * colors (the caller sets the ambient color; see `.dw-rules-fig`). Territories
 * are drawn as flat-top hexes with the dice count written inside — the board's
 * own "numbers" dice display — and dice as pipped rounded squares.
 *
 * Note SVG presentation attributes are spelled kebab-case (`stroke-width`, not
 * `strokeWidth`): Preact passes attribute names straight to setAttribute for
 * SVG-namespaced elements, and SVG attribute names are case-sensitive, so a
 * camelCase prop silently does nothing.
 *
 * @module ui/rulesArt
 */

/** Circumradius of every hex in these figures. */
const HEX_R = 13;

/**
 * Flat-top hexagon outline: six vertices stepped 60° around (cx, cy).
 * Flat-top neighbours therefore sit 1.5r apart across and √3·r apart down.
 */
function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * 60 * i;
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return pts.join(' ');
}

/**
 * One territory.
 *
 * @param {Object} props
 * @param {number} props.cx
 * @param {number} props.cy
 * @param {boolean} [props.mine] - Filled in the accent (yours) rather than muted
 * @param {number|string|null} [props.dice] - Dice count written inside, if any
 * @param {number} [props.fade] - Fill opacity override (a territory that doesn't count)
 * @param {boolean} [props.dashed] - Dashed outline: not taken yet
 */
function Hex({ cx, cy, mine = false, dice = null, fade = null, dashed = false }) {
  const fillOpacity = fade === null ? (mine ? 0.85 : 0.16) : fade;
  return (
    <g>
      <polygon
        points={hexPoints(cx, cy, HEX_R)}
        fill={mine ? 'var(--ui-accent)' : 'currentColor'}
        fill-opacity={fillOpacity}
        stroke={dashed ? 'var(--ui-accent)' : 'currentColor'}
        stroke-width="1.3"
        stroke-opacity="0.75"
        stroke-dasharray={dashed ? '4 3' : undefined}
      />
      {dice !== null && (
        <text
          x={cx}
          y={cy + 4.6}
          text-anchor="middle"
          font-family="Anton, sans-serif"
          font-size="13"
          fill={mine ? '#ffffff' : 'currentColor'}
        >
          {dice}
        </text>
      )}
    </g>
  );
}

/** Pip positions per face, on a −1…1 grid centred on the die. */
const PIPS = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};

/**
 * One rolled die: outlined square plus pips, all in the ambient color.
 *
 * @param {Object} props
 * @param {number} props.x - Left edge
 * @param {number} props.y - Top edge
 * @param {number} props.face - 1–6
 * @param {number} [props.size]
 */
function Die({ x, y, face, size = 14 }) {
  const mid = size / 2;
  const step = size * 0.26;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={size}
        height={size}
        rx={size * 0.22}
        fill="currentColor"
        fill-opacity="0.1"
        stroke="currentColor"
        stroke-width="1.3"
      />
      {PIPS[face].map(([ux, uy]) => (
        <circle
          key={`${ux},${uy}`}
          cx={x + mid + ux * step}
          cy={y + mid + uy * step}
          r={size * 0.085}
          fill="currentColor"
        />
      ))}
    </g>
  );
}

/** Shared frame: every figure is drawn on the same 132×76 stage. */
function Figure({ children }) {
  return (
    <svg viewBox="0 0 132 76" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Goal: a board that is all yours bar the one territory still to take. */
export function GoalFigure() {
  return (
    <Figure>
      <Hex cx={46.5} cy={26.7} mine />
      <Hex cx={46.5} cy={49.3} mine />
      <Hex cx={66} cy={15.5} mine />
      <Hex cx={66} cy={38} mine />
      <Hex cx={66} cy={60.5} mine />
      <Hex cx={85.5} cy={26.7} mine />
      <Hex cx={85.5} cy={49.3} dashed />
    </Figure>
  );
}

/** Attack: click yours, then the enemy next door. */
export function AttackFigure() {
  const badge = (cx, label) => (
    <g>
      <circle
        cx={cx}
        cy={19}
        r="7.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-opacity="0.75"
      />
      <text
        x={cx}
        y={22.4}
        text-anchor="middle"
        font-family="Roboto, sans-serif"
        font-size="10"
        fill="currentColor"
      >
        {label}
      </text>
    </g>
  );
  return (
    <Figure>
      {badge(56, '1')}
      {badge(75.5, '2')}
      <Hex cx={56} cy={46} mine dice="3" />
      <Hex cx={75.5} cy={46} dice="2" />
    </Figure>
  );
}

/** Battle: both sides roll everything; the bigger total takes it. */
export function BattleFigure() {
  const label = (x, text) => (
    <text
      x={x}
      y={17}
      text-anchor="middle"
      font-family="Roboto, sans-serif"
      font-size="8.5"
      letter-spacing="1.4"
      fill="currentColor"
      fill-opacity="0.8"
    >
      {text}
    </text>
  );
  const total = (x, text, accent) => (
    <text
      x={x}
      y={56}
      text-anchor="middle"
      font-family="Anton, sans-serif"
      font-size="15"
      fill={accent ? 'var(--ui-accent)' : 'currentColor'}
    >
      {text}
    </text>
  );
  return (
    <Figure>
      <g style={{ color: 'var(--ui-accent)' }}>
        {label(41, 'YOU')}
        <Die x={16} y={24} face={5} />
        <Die x={33} y={24} face={3} />
        <Die x={50} y={24} face={4} />
      </g>
      {total(41, '12', true)}
      <text
        x={74}
        y={38}
        text-anchor="middle"
        font-family="Anton, sans-serif"
        font-size="17"
        fill="currentColor"
      >
        &gt;
      </text>
      {label(99.5, 'THEM')}
      <Die x={84} y={24} face={6} />
      <Die x={101} y={24} face={4} />
      {total(99.5, '10', false)}
    </Figure>
  );
}

/** Reinforce: new dice come from the biggest connected group, not the total. */
export function ReinforceFigure() {
  return (
    <Figure>
      <Hex cx={32} cy={32} mine />
      <Hex cx={51.5} cy={20.7} mine />
      <Hex cx={51.5} cy={43.3} mine />
      <Hex cx={71} cy={32} mine />
      {/* Yours too, but cut off from the group — it adds nothing to the count. */}
      <Hex cx={110} cy={32} mine fade={0.3} />
      <text
        x={51.5}
        y={70}
        text-anchor="middle"
        font-family="Anton, sans-serif"
        font-size="16"
        fill="var(--ui-accent)"
      >
        +4
      </text>
    </Figure>
  );
}

/** Tips: a tall stack beats a short one nearly every time. */
export function TipsFigure() {
  return (
    <Figure>
      <Hex cx={42} cy={38} mine dice="8" />
      <Hex cx={61.5} cy={38} dice="3" />
      <path
        d="M86 39 l7 8 l14 -18"
        fill="none"
        stroke="var(--ui-accent)"
        stroke-width="3.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </Figure>
  );
}
