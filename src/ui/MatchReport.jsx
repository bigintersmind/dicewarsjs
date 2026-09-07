const CSS = `
.dw-report { width: min(440px, 100%); margin: 0 0 1.4rem; color: var(--ui-text);
  font-family: Roboto, sans-serif; border-block: 1px solid var(--ui-border); padding: 1rem 0; }
.dw-report-head { display: flex; justify-content: space-between; gap: .5rem; align-items: baseline; }
.dw-report h2 { font-size: .7rem; text-transform: uppercase; letter-spacing: .12em; margin: 0; }
.dw-report-head span, .dw-report figcaption { color: var(--ui-text-muted); font-size: .7rem; }
.dw-report dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem; margin: .8rem 0; }
.dw-report dl div { display: flex; flex-direction: column-reverse; gap: .15rem; }
.dw-report dt { font-size: .7rem; color: var(--ui-text-muted); }
.dw-report dd { font: 1.7rem Anton, sans-serif; margin: 0; }
.dw-report figure { margin: 0; }
.dw-report svg { display: block; width: 100%; height: 68px; color: var(--ui-accent); overflow: visible; }
.dw-report figcaption { margin-top: .4rem; display: flex; justify-content: space-between; }
.dw-report-note { margin: .8rem 0 0; color: var(--ui-text-muted); font-size: .8rem; line-height: 1.5; }
`;

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
  const chartLabel = `Your territory over the match: started with ${first}, peaked at ${peakTerritories}, finished with ${last}.`;

  return (
    <section className="dw-report" aria-label="Your campaign">
      <style>{CSS}</style>
      <div className="dw-report-head">
        <h2>Your campaign</h2>
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
          <dt>Best income / turn</dt>
          <dd>+{peakIncome}</dd>
        </div>
      </dl>
      <figure>
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
          <span>{first} land at the start</span>
          <span>{last} at the finish</span>
        </figcaption>
      </figure>
      {daily && (
        <p className="dw-report-note">
          {dailyResult?.available === false
            ? 'This result could not be saved in your browser.'
            : dailyResult?.record?.wins
              ? `Personal best: a win in ${dailyResult.record.bestTurns} turns. Try the same board with a new plan.`
              : 'The board stays the same. Try a different opening and make it yours.'}
        </p>
      )}
    </section>
  );
}
