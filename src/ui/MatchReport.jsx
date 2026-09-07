/**
 * Match Report
 *
 * The "your campaign" card on the game-over screen: three numbers and the
 * shape of the match. The numbers are the priority — they are what a player
 * reads, quotes and compares — so they are set large across the top of an
 * opaque card, and the chart sits under them as the quieter, secondary half.
 *
 * Its words are the rules card's words: "land", "reinforcements", "largest
 * connected group" (see SupplyStatus's note on the one vocabulary).
 *
 * The card is opaque (`--ui-panel-bg`) rather than the translucent overlay it
 * used to inherit: the chart stroke is `--ui-accent`, which measured 2.8:1
 * against the brightest board pixels through the dark theme's overlay — under
 * the 3:1 a graphic owes (#220, themes.js).
 *
 * @module ui/MatchReport
 */

const REPORT_CSS = `
.dw-report { width: min(440px, 100%); margin: 0 0 1.4rem; color: var(--ui-text);
  font-family: Roboto, sans-serif; background: var(--ui-panel-bg);
  border: 1px solid var(--ui-border); border-radius: 8px; padding: 1rem 1.1rem; }
.dw-report-head { display: flex; justify-content: space-between; gap: .5rem; align-items: baseline; }
.dw-report h2 { font-size: .7rem; text-transform: uppercase; letter-spacing: .12em; margin: 0; }
.dw-report-head span, .dw-report figcaption { color: var(--ui-text-muted); font-size: .7rem; }
.dw-report dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: .6rem;
  margin: .9rem 0 1.1rem; }
.dw-report dl div { display: flex; flex-direction: column-reverse; gap: .15rem; }
.dw-report dt { font-size: .7rem; color: var(--ui-text-muted); line-height: 1.3; }
.dw-report dd { font: 2rem Anton, sans-serif; margin: 0; line-height: 1;
  font-variant-numeric: tabular-nums; }
.dw-report figure { margin: 0; }
.dw-report svg { display: block; width: 100%; height: 56px; color: var(--ui-accent);
  overflow: visible; }
.dw-report figcaption { margin-top: .4rem; display: flex; justify-content: space-between;
  gap: .5rem; }
.dw-report-note { margin: .8rem 0 0; color: var(--ui-text-muted); font-size: .8rem; line-height: 1.5; }
@media (max-width: 440px) {
  .dw-report { padding: .85rem; }
  .dw-report dd { font-size: 1.6rem; }
}
`;

/**
 * @param {Object} props
 * @param {Object} props.journal - store.matchJournal (only rendered once finished)
 * @param {Object} [props.daily] - store.dailyChallenge, when this was a daily
 * @param {Object} [props.dailyResult] - store.dailyResult, when this was a daily
 */
export function MatchReport({ journal, daily, dailyResult }) {
  if (!journal?.finished) return null;
  const { points, turns, captures, attacks, peakTerritories, peakIncome } = journal;
  const first = points[0].territories;
  const last = points.at(-1).territories;
  const maxTurn = Math.max(1, points.at(-1).turn);
  const maxLand = Math.max(1, peakTerritories);
  const coordinates = points.map(
    p => `${(p.turn / maxTurn) * 400},${60 - (p.territories / maxLand) * 52}`
  );
  const line = coordinates.join(' ');
  const finalX = (points.at(-1).turn / maxTurn) * 400;
  const chartLabel = `Your territory after each of your turns: started with ${first}, peaked at ${peakTerritories}, finished with ${last}.`;

  return (
    <section className="dw-report" aria-labelledby="dw-report-title">
      <style>{REPORT_CSS}</style>
      <div className="dw-report-head">
        <h2 id="dw-report-title">Your campaign</h2>
        <span>{attacks ? `${captures} of ${attacks} attacks won` : 'No attacks made'}</span>
      </div>
      <dl>
        <div>
          <dt>Your turns</dt>
          <dd>{turns}</dd>
        </div>
        <div>
          <dt>Most land held</dt>
          <dd>{peakTerritories}</dd>
        </div>
        <div>
          <dt>Most reinforcements</dt>
          <dd>+{peakIncome}</dd>
        </div>
      </dl>
      <figure>
        {/* The samples are one per human turn (the journal records them on your
            END TURN, plus the start and the finish), so the caption says whose
            clock the x-axis is on. Same for the text alternative — the chart is
            a graphic with no data table behind it, so `role="img"` plus a label
            is the whole of what a screen reader gets. */}
        <svg viewBox="0 0 400 68" role="img" aria-label={chartLabel} preserveAspectRatio="none">
          <polygon points={`0,64 ${line} ${finalX},64`} fill="currentColor" opacity=".12" />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </svg>
        <figcaption>
          <span>Land after each of your turns</span>
          <span>
            {first} → {last}
          </span>
        </figcaption>
      </figure>
      {/* The practice/scored verdict is the game-over screen's own line, right
          under this card; what belongs here is the note about the board — and,
          when it applies, the one thing that changes what the result means. */}
      {daily && (dailyResult?.available === false || dailyResult?.official) && (
        <p className="dw-report-note">
          {dailyResult.available === false
            ? 'This result could not be saved in your browser.'
            : 'Everyone plays the same board and the same dice today.'}
        </p>
      )}
    </section>
  );
}
