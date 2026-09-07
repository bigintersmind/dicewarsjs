/**
 * Daily Conquest card
 *
 * The title screen's second offer, under the setup panel: today's board, the
 * same one for everybody, with the same dice tape. It shows what you did with
 * it — once — and then keeps letting you play.
 *
 * The one scored attempt is the product decision this card has to make legible.
 * Before an official result the button says PLAY DAILY. After one it says
 * PRACTICE, with the result, the streak and (when it was posted) the name and
 * rank above it, and a line saying practice runs are not scored. It never says
 * "TRY AGAIN": that is the ordinary game's word for replaying a board, and here
 * it would promise a second scored attempt that does not exist.
 *
 * The leaderboard snippet is best-effort by design. It is a nicety on a landing
 * page, so a slow or failed fetch shows nothing at all — no spinner, no error
 * text — rather than putting a network problem in front of someone who wants to
 * press a button. Only a real storage failure gets copy, because that one
 * changes what the card can promise. A failure is still written to the console
 * once, so a misconfigured origin is diagnosable without being player-facing.
 *
 * @module ui/DailyChallengeCard
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { createDailyChallenge, dailyDate, formatDailyDate } from '../game/dailyChallenge.js';
import { readDailyRecord } from '../store/dailyRecords.js';
import { fetchDailyLeaderboard, isLeaderboardEnabled } from '../game/dailyLeaderboard.js';

/*
 * `.dw-opt.dw-daily-opt` is doubled on purpose — the fourth of the opt-outs
 * catalogued in menuChrome.jsx's coarse-pointer block, and pinned in
 * tests/ui/touchTargets.test.js. This card mounts CHROME_CSS nowhere, but
 * SettingsPanel mounts a copy on every screen, so the shared `.dw-opt` rules do
 * reach this button; a bare class here would tie with the coarse block at
 * (0,1,0) and let mount order decide its padding. The touch sizing therefore
 * lives behind (pointer: coarse) like every other opt-out, and the desktop box
 * is a single declaration per property so the pins can hold it.
 */
const DAILY_CSS = `
.dw-daily { width: min(100%, 640px); margin: 1.6rem auto 0; padding: 1rem 1.2rem;
  border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-panel-bg);
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  flex-wrap: wrap; text-align: left; }
.dw-daily h2 { margin: 0 0 .3rem; font: 1.25rem Anton, sans-serif; letter-spacing: .04em;
  color: var(--ui-text); }
.dw-daily p { margin: .2rem 0 0; font: .8rem/1.5 Roboto, sans-serif; color: var(--ui-text-muted); }
.dw-daily-date { color: var(--ui-text); font: .7rem Roboto, sans-serif;
  letter-spacing: .08em; text-transform: uppercase; margin-bottom: .3rem; }
.dw-daily-result { color: var(--ui-text); font: .85rem/1.5 Roboto, sans-serif; }
.dw-daily-board { margin: .6rem 0 0; padding: .5rem 0 0; border-top: 1px solid var(--ui-border);
  width: 100%; min-height: 4.4rem; font: .75rem/1.6 Roboto, sans-serif;
  color: var(--ui-text-muted); }
.dw-daily-board:empty { border-top-color: transparent; }
.dw-daily-board ol { margin: 0; padding: 0; list-style: none; }
.dw-daily-board li { display: flex; gap: .5rem; }
.dw-daily-board li span:first-child { color: var(--ui-text); }
.dw-opt.dw-daily-opt { font-size: 1.05rem; padding: 0.35rem 0.7rem; white-space: nowrap; }
@media (max-width: 440px) {
  .dw-daily { padding: .85rem; gap: .5rem; }
}
@media (pointer: coarse) {
  .dw-opt.dw-daily-opt { padding: 0.45rem 0.9rem; min-height: 44px; }
}
`;

/** The result line for an official attempt: what you did, in one sentence. */
function describeResult(official) {
  if (official.won) return `Today: won in ${official.turns} turns.`;
  if (official.drew) return `Today: a draw after ${official.turns} turns.`;
  return `Today: eliminated after ${official.turns} turns.`;
}

/**
 * Today's leaderboard, or null. Best-effort: a failed or slow fetch leaves the
 * snippet out entirely (see the module note), and a fetch that lands after the
 * card has unmounted — or after UTC midnight rolled the board over — is dropped
 * rather than written into a stale render.
 *
 * The failure is silent to the PLAYER, not to us: anything but `disabled` (the
 * build simply has no leaderboard) is warned once per mount, so a bad origin,
 * an unmigrated database or a broken response can be diagnosed from the console
 * instead of looking identical to "nobody has finished today".
 *
 * @param {string} date - The board date being shown
 * @returns {import('../game/dailyLeaderboard.js').LeaderboardPage | null}
 */
function useDailyLeaderboard(date) {
  const [page, setPage] = useState(null);
  const warned = useRef(false);
  useEffect(() => {
    if (!isLeaderboardEnabled()) return undefined;
    let live = true;
    setPage(null);
    Promise.resolve()
      .then(() => fetchDailyLeaderboard(date))
      .then(result => {
        if (live) setPage(result);
      })
      .catch(err => {
        if (!live) return;
        setPage(null);
        if (err?.code !== 'disabled' && !warned.current) {
          warned.current = true;
          console.warn('[Daily Conquest] leaderboard unavailable:', err);
        }
      });
    return () => {
      live = false;
    };
  }, [date]);
  return page;
}

/**
 * @param {Object} props
 * @param {(date: string) => void} props.onStart - Play today's board (scored
 *   the first time it is completed, practice after that)
 */
export function DailyChallengeCard({ onStart }) {
  const [date, setDate] = useState(dailyDate);
  const [{ record, available, streak }, setRecord] = useState(() =>
    readDailyRecord(createDailyChallenge(date).id)
  );
  const dateRef = useRef(date);
  dateRef.current = date;

  useEffect(() => {
    const reread = today => setRecord(readDailyRecord(createDailyChallenge(today).id));
    /*
     * Two different jobs, deliberately not the same handler. The timer only has
     * to notice UTC midnight, so on all but one tick a day it compares two
     * strings and stops — no storage read, no setState, no re-render of a card
     * nobody is looking at. The events are the ones that can mean the record
     * itself changed underneath us: a second tab finishing today's run
     * ('storage'), or coming back to this one ('focus').
     */
    const tick = () => {
      const today = dailyDate();
      if (today === dateRef.current) return;
      setDate(today);
      reread(today);
    };
    const refresh = () => {
      const today = dailyDate();
      if (today !== dateRef.current) setDate(today);
      reread(today);
    };
    const timer = setInterval(tick, 60000);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  /*
   * The label and the record refresh on the 60s tick; the CLOCK does not wait
   * for it. A tab left open across 00:00 UTC could therefore show PRACTICE and
   * a spent result while this handler started a fresh, scored board — the card
   * describing yesterday and the game playing today. So the date is read again
   * at the click and, when it has moved, the card is caught up in the same
   * gesture before the game starts.
   */
  const start = () => {
    const today = dailyDate();
    if (today !== dateRef.current) {
      setDate(today);
      setRecord(readDailyRecord(createDailyChallenge(today).id));
    }
    onStart(today);
  };

  const page = useDailyLeaderboard(date);
  const official = record?.official ?? null;
  const submission = official?.submission ?? null;
  const top = page?.entries?.slice(0, 3) ?? [];

  return (
    <section className="dw-daily" aria-labelledby="dw-daily-title">
      <style>{DAILY_CSS}</style>
      <div>
        <div className="dw-daily-date">{formatDailyDate(date)} · New board at 00:00 UTC</div>
        {/* An h2 under TitleScreen's own visually-hidden h1 ("Dice Wars"): the
            screen's name is the wordmark SVG, an image with a label rather
            than a heading, so the page needs an h1 of its own and this card is
            a section within it. The section is labelled BY this heading rather
            than carrying a duplicate aria-label. */}
        <h2 id="dw-daily-title">DAILY CONQUEST</h2>
        {official ? (
          <>
            <p className="dw-daily-result">{describeResult(official)}</p>
            {streak >= 2 && <p>Streak: {streak} days</p>}
            {submission && (
              <p>
                Posted as {submission.name}
                {submission.rank ? ` · #${submission.rank}` : ''}
              </p>
            )}
            <p>Practice runs don’t count.</p>
          </>
        ) : (
          <>
            <p>One board. Four players. Your move.</p>
            <p>
              {available
                ? 'Small · Standard · Fair dice — everyone plays the same board and the same dice.'
                : 'Personal results can’t be saved in this browser.'}
            </p>
            {/* The rule the card is built around, in copy a player can read —
                it used to live only in the button's `title`, which never
                reaches a touch screen and rarely reaches anyone else. */}
            <p>Your first finished run is the scored one; practice runs don’t count.</p>
          </>
        )}
      </div>
      <button className="dw-opt dw-daily-opt" type="button" onClick={start}>
        {official ? 'PRACTICE' : 'PLAY DAILY'}
      </button>
      {/*
       * The slot is reserved whether or not the fetch lands, so the footer
       * below the card does not jump when it resolves — the snippet arrives
       * into space that was already there.
       */}
      {isLeaderboardEnabled() && (
        <div className="dw-daily-board">
          {top.length > 0 && (
            <>
              <ol aria-label="Today’s top three">
                {top.map(entry => (
                  <li key={entry.rank}>
                    <span>#{entry.rank}</span>
                    <span>{entry.name}</span>
                    <span>{entry.turns} turns</span>
                  </li>
                ))}
              </ol>
              <div>
                {page.totals.finished} finished today · {page.totals.won} won
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
