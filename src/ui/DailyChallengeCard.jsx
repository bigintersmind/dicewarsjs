import { useEffect, useState } from 'preact/hooks';
import { createDailyChallenge, dailyDate, formatDailyDate } from '../game/dailyChallenge.js';
import { readDailyRecord } from '../store/dailyRecords.js';

const CSS = `
.dw-daily { width: min(100%, 640px); margin: 1.6rem auto 0; padding: 1rem 1.2rem;
  border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-bg);
  display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.dw-daily h2 { margin: 0 0 .3rem; font: 1.25rem Anton, sans-serif; letter-spacing: .04em; }
.dw-daily p { margin: .2rem 0 0; font: .8rem/1.5 Roboto, sans-serif; color: var(--ui-text-muted); }
.dw-daily-date { color: var(--ui-accent); font: .7rem Roboto, sans-serif;
  letter-spacing: .08em; text-transform: uppercase; margin-bottom: .3rem; }
.dw-daily .dw-opt { white-space: nowrap; font-size: 1.1rem; min-height: 44px; }
@media (max-width: 440px) {
  .dw-daily { padding: .85rem; gap: .5rem; }
  .dw-daily h2 { font-size: 1.1rem; }
  .dw-daily .dw-opt { font-size: .95rem; padding-left: .2rem; padding-right: .2rem; }
}
`;

export function DailyChallengeCard({ onStart }) {
  const [date, setDate] = useState(dailyDate);
  const [{ record, available }, setRecord] = useState(() =>
    readDailyRecord(createDailyChallenge(date).id)
  );
  useEffect(() => {
    const refresh = () => {
      const today = dailyDate();
      setDate(today);
      setRecord(readDailyRecord(createDailyChallenge(today).id));
    };
    const timer = setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return (
    <section className="dw-daily" aria-label="Daily Conquest">
      <style>{CSS}</style>
      <div>
        <div className="dw-daily-date">{formatDailyDate(date)} · New board at 00:00 UTC</div>
        <h2>DAILY CONQUEST</h2>
        <p>One board. Four players. Your move.</p>
        <p>
          {!available
            ? 'Personal bests are unavailable in this browser.'
            : record?.wins
              ? `Best win: ${record.bestTurns} turns · ${record.completed} completed attempts`
              : record
                ? `${record.completed} completed ${record.completed === 1 ? 'attempt' : 'attempts'} · Still yours to conquer`
                : 'Small · Standard · Fair dice'}
        </p>
      </div>
      <button className="dw-opt" type="button" onClick={() => onStart(dailyDate())}>
        {record ? 'TRY AGAIN' : 'PLAY DAILY'} <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
