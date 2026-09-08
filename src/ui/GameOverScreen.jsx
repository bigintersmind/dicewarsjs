/**
 * Game Over Screen
 *
 * Overlay showing the winner with a HOME button (back to the landing
 * screen) plus, when available, PRACTICE AGAIN / TRY AGAIN, HISTORY, SPECTATE
 * and HOW TO PLAY — and, after a scored Daily Conquest run, the two things you
 * can do with that result: copy it and post it.
 *
 * @module ui/GameOverScreen
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { SeatSwatch } from './SeatSwatch.jsx';
import { playerName } from '../store/GameStore.js';
import { MatchReport } from './MatchReport.jsx';
import { formatDailyDate } from '../game/dailyChallenge.js';
import { formatDailyShare } from '../game/dailyShare.js';
import { isLeaderboardEnabled, normalizeName } from '../game/dailyLeaderboard.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';

/** The screen's one button shape; `mutedBtn` is the same outline, quieter ink. */
const BTN = {
  fontFamily: 'Anton, sans-serif',
  fontSize: '1.3rem',
  padding: '0.6rem 2rem',
  background: 'transparent',
  border: '2px solid var(--ui-accent)',
  color: 'var(--ui-accent)',
  cursor: 'pointer',
  borderRadius: '6px',
  letterSpacing: '0.05em',
};

/**
 * localStorage key for the name last posted to the daily leaderboard, so the
 * form is prefilled tomorrow. Named for what it holds; nothing else reads it.
 */
const NAME_STORAGE_KEY = 'dicewars_daily_name';

/** How long the inline "Copied" confirmation stays up. */
const COPIED_MS = 2500;

/*
 * The share/post block's own controls. They are NOT `.dw-opt` — that class
 * belongs to the bare-text menu idiom and pulls in the shared chrome sheet's
 * coarse-pointer sizing (see menuChrome.jsx) — so they carry their own class
 * and their own touch floor, behind (pointer: coarse) like every other rule
 * that grows a box (#222). Pinned in tests/ui/touchTargets.test.js.
 *
 * The buttons and the name field take `--ui-border-strong`, not `--ui-border`:
 * they are CONTROLS whose only visible boundary is that line, and the plain
 * border measures ~2.5:1 on `--ui-panel-bg` in both themes against the 3:1
 * WCAG 1.4.11 asks (themes.js, tests/renderer/themes.test.js). The panel's own
 * edge stays on the hairline — it divides surfaces rather than bounding a
 * control.
 */
const RESULT_CSS = `
.dw-result-spacer { margin-top: auto; }
.dw-result-bottom { margin-bottom: auto; }
.dw-result > * { flex-shrink: 0; }
.dw-result-date { color: var(--ui-text); font: .8rem Roboto, sans-serif;
  letter-spacing: .08em; margin-bottom: .7rem; }
.dw-result-practice { margin: 0 0 1.4rem; color: var(--ui-text-muted);
  font: .85rem Roboto, sans-serif; }
.dw-daily-actions { width: min(440px, 100%); margin: 0 0 1.4rem; padding: .9rem 1.1rem;
  background: var(--ui-panel-bg); border: 1px solid var(--ui-border); border-radius: 8px;
  color: var(--ui-text); font-family: Roboto, sans-serif; text-align: left; }
.dw-daily-actions h2 { margin: 0 0 .6rem; font-size: .7rem; text-transform: uppercase;
  letter-spacing: .12em; }
.dw-daily-actions p { margin: .5rem 0 0; font-size: .8rem; line-height: 1.5;
  color: var(--ui-text-muted); }
.dw-daily-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.dw-daily-row label { font-size: .75rem; color: var(--ui-text-muted); }
.dw-share-btn { font-family: Anton, sans-serif; font-size: .95rem; letter-spacing: .04em;
  padding: .4rem 1rem; background: transparent; color: var(--ui-text);
  border: 2px solid var(--ui-border-strong); border-radius: 6px; cursor: pointer; }
.dw-share-btn:hover { border-color: var(--ui-accent); }
.dw-share-btn:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.dw-share-btn[aria-disabled='true'] { opacity: .55; cursor: default; }
.dw-daily-name { font-family: Roboto, sans-serif; font-size: .9rem; padding: .4rem .5rem;
  min-width: 9rem; color: var(--ui-text); background: var(--ui-panel-bg);
  border: 1px solid var(--ui-border-strong); border-radius: 6px; }
.dw-daily-name[readonly] { opacity: .7; }
.dw-share-text { width: 100%; margin-top: .5rem; font-family: Roboto, sans-serif;
  font-size: .8rem; line-height: 1.5; padding: .4rem .5rem; color: var(--ui-text);
  background: var(--ui-panel-bg); border: 1px solid var(--ui-border-strong); border-radius: 6px; }
.dw-daily-actions .dw-daily-live { min-height: 1.2em; }
.dw-daily-actions .dw-daily-live-error { color: var(--ui-danger); }
@media (pointer: coarse) {
  .dw-share-btn { min-height: 44px; }
  .dw-daily-name { min-height: 44px; font-size: 16px; }
}
`;

const STYLE = {
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-start',
    alignItems: 'center',
    background: 'var(--ui-overlay-bg)',
    pointerEvents: 'auto',
    overflowY: 'auto',
    padding: '2rem 1.25rem',
  },
  /*
   * The heading sits on this screen's own overlay, not the raw board, so its
   * shadow is depth rather than legibility — but a fixed dark one smudged under
   * the light theme's navy text. The ink-rim halo keeps the depth where it
   * reads (dark ink under white) and all but vanishes in the light theme,
   * whose own ink is pale (#220).
   */
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: 'clamp(1.6rem, 5vw, 3.5rem)',
    color: 'var(--ui-text)',
    letterSpacing: '0.3em',
    marginBottom: '1rem',
    textShadow: 'var(--ui-text-halo)',
  },
  /* The winner's seat rides beside this line as a swatch, never in the ink:
     on the light theme's panel a pastel seat as text measured near 1:1 (#220). */
  winner: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    color: 'var(--ui-text)',
    marginBottom: '2rem',
  },
  buttonRow: {
    display: 'flex',
    gap: '1rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  btn: BTN,
  /** A reference sitting beside the real actions, so: smaller and greyed. */
  mutedBtn: {
    ...BTN,
    fontSize: '1.05rem',
    padding: '0.55rem 1.4rem',
    border: '2px solid var(--ui-border)',
    color: 'var(--ui-text-muted)',
  },
};

/** The name last posted, or ''. A browser that refuses storage just starts blank. */
function readRememberedName() {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/** Remember the name for tomorrow. A refusal here costs nothing worth reporting. */
function rememberName(name) {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    /* A browser that refuses storage simply won't prefill next time. */
  }
}

/**
 * "Posted as ACE · #4" — the leaderboard confirmation, from whichever record of
 * the posting is in hand (the stored submission, or the one just made).
 *
 * @param {{ name: string, rank: number | null } | null} posting
 * @returns {string | null}
 */
function confirmationFor(posting) {
  if (!posting) return null;
  return `Posted as ${posting.name}${posting.rank ? ` · #${posting.rank}` : ''}`;
}

/**
 * The share/post block for a scored daily result: COPY RESULT (and SHARE where
 * the platform has a share sheet), then the leaderboard form.
 *
 * The clipboard is not assumed. `navigator.clipboard` is absent outside secure
 * contexts and `writeText` can reject on a permission prompt, so either one
 * falls back to a readonly textarea holding the same text, selected and ready
 * to copy by hand — the result is never unreachable.
 *
 * Every outcome — copied, posted, refused — is announced through ONE
 * `aria-live` element that is a sibling of the controls and is present (empty)
 * from the first render. It is not inside a button: a live region that only
 * exists once there is something to say is not reliably announced, and a
 * confirmation buried in a focused button's accessible NAME is a name change
 * screen readers routinely miss. This screen still has exactly one
 * `role="status"` and it belongs to App's ScreenReaderAnnouncer; this element
 * deliberately carries none.
 *
 * @param {Object} props
 * @param {string} props.shareText - The pasteable result (dailyShare.js)
 * @param {Object | null} props.submission - record.official.submission, if posted
 * @param {(name: string) => Promise<Object>} [props.onSubmitScore]
 * @param {{ current: HTMLElement | null }} [props.firstControlRef] - Set to
 *   COPY RESULT, this block's first control, so the screen can place its one
 *   mount-focus claim here instead of on HOME below the fold.
 */
function DailyShareBlock({ shareText, submission, onSubmitScore, firstControlRef }) {
  const [showText, setShowText] = useState(false);
  const [name, setName] = useState(readRememberedName);
  const [pending, setPending] = useState(false);
  const [posted, setPosted] = useState(null);
  /* `{ text, tone }` for the one live element; `quiet` is announced but not
     shown, for an outcome another control already displays. */
  const [status, setStatus] = useState(null);
  const textRef = useRef(null);
  const copiedTimer = useRef(null);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  /*
   * A line is always cleared before it is set again, in a render of its own. A
   * live region only speaks when its text CHANGES, so saying the same sentence
   * twice — a second COPY inside the confirmation window, a second press with
   * no clipboard behind it — is a setState no-op that announces nothing at all.
   *
   * `post()` and `copy()` get that empty render for free: both clear in the
   * click and answer something asynchronous (a round trip, the clipboard) in a
   * later tick. `revealText()` decides and speaks in the same breath, so the
   * microtask is what hands the DOM the empty render in between.
   */
  const announce = next => {
    setStatus(null);
    queueMicrotask(() => setStatus(next));
  };

  const revealText = () => {
    setShowText(true);
    announce({ text: 'Copy it from the box below.', tone: 'info' });
    // Queued: the textarea does not exist until this render commits.
    queueMicrotask(() => textRef.current?.select());
  };

  /*
   * All three handlers call out SYNCHRONOUSLY, inside the click, and only then
   * await. The clipboard and the share sheet are gated on transient user
   * activation, which a `Promise.resolve().then(...)` hop spends before the
   * call is made — the copy would be refused in exactly the browsers that are
   * strictest about it. A synchronous throw (no permission, no share target) is
   * handled here rather than left to a rejection that never comes.
   */
  const copy = () => {
    // Cleared in the click, said again when the clipboard answers — the same
    // two-render shape `post()` uses, and what makes a repeat press audible.
    setStatus(null);
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      revealText();
      return;
    }
    let written;
    try {
      written = clipboard.writeText(shareText);
    } catch {
      revealText();
      return;
    }
    Promise.resolve(written)
      .then(() => {
        const copied = { text: 'Copied', tone: 'info' };
        setStatus(copied);
        clearTimeout(copiedTimer.current);
        // Only clears its own message: a post that landed in the meantime keeps
        // its confirmation up rather than being wiped by the copy's timer.
        copiedTimer.current = setTimeout(
          () => setStatus(current => (current === copied ? null : current)),
          COPIED_MS
        );
      })
      .catch(revealText);
  };

  const share = () => {
    try {
      Promise.resolve(navigator.share({ text: shareText })).catch(err => {
        // A cancelled share sheet is the user saying no, and gets no answer.
        // Anything else IS a failure, and the result must still be reachable.
        if (err?.name !== 'AbortError') revealText();
      });
    } catch {
      /* No share target after all — fall back to the text itself. */
      revealText();
    }
  };

  const alreadyPosted = submission ?? posted;
  const confirmation = confirmationFor(alreadyPosted);

  const post = () => {
    if (pending || alreadyPosted || !onSubmitScore) return;
    /*
     * The server normalizes (trim, collapse whitespace) before it stores a
     * name, so the confirmation and the remembered prefill have to be the
     * normalized form too, or " ace " comes back tomorrow and reads as a
     * different player than the leaderboard shows. The RAW value is what gets
     * submitted: rejecting it here would duplicate the controller's own
     * validation and its coded error message.
     */
    const raw = name;
    const normalized = normalizeName(raw) ?? raw;
    setPending(true);
    setStatus(null);
    /*
     * `.code` is the leaderboard client's own contract (dailyLeaderboard.js):
     * a coded rejection carries a sentence written FOR the player, and that is
     * the one we print. Anything else is a bug on our side — a broken store
     * subscriber, a TypeError — whose message is jargon at best and internals
     * at worst, so it goes to the console (where it was previously lost
     * entirely) and the card says the one thing a player can act on.
     */
    const fail = err => {
      const coded = Boolean(err?.code);
      if (!coded) console.error('[Daily Conquest] Submission failed:', err);
      setStatus({
        text: (coded && err.message) || 'Could not post your result.',
        tone: 'error',
      });
      setPending(false);
    };
    let submitted;
    try {
      submitted = onSubmitScore(raw);
    } catch (err) {
      fail(err);
      return;
    }
    Promise.resolve(submitted)
      .then(result => {
        rememberName(normalized);
        const posting = { name: normalized, rank: result?.rank ?? null };
        setPosted(posting);
        setPending(false);
        // `quiet`: the POST button now shows this same line, so the live
        // element announces it without printing it on the card twice.
        setStatus({ text: confirmationFor(posting), tone: 'quiet' });
      })
      .catch(fail);
  };

  const submit = event => {
    // Enter in the name field is a submit, and the browser would navigate.
    event.preventDefault();
    post();
  };

  const liveClass =
    status?.tone === 'error' ? 'dw-daily-live dw-daily-live-error' : 'dw-daily-live';

  return (
    <section className="dw-daily-actions" aria-labelledby="dw-daily-actions-title">
      <h2 id="dw-daily-actions-title">Your result</h2>
      <div className="dw-daily-row">
        <button type="button" className="dw-share-btn" onClick={copy} ref={firstControlRef}>
          COPY RESULT
        </button>
        {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
          <button type="button" className="dw-share-btn" onClick={share}>
            SHARE
          </button>
        )}
      </div>
      {showText && (
        <textarea
          className="dw-share-text"
          ref={textRef}
          readOnly
          rows={4}
          value={shareText}
          aria-label="Your result, ready to copy"
        />
      )}
      {/*
       * The row stays mounted through the post. Swapping it for a static
       * sentence on success unmounted the element that held focus, dropping
       * the keyboard to the body with nothing announced; the button becomes
       * the confirmation instead, and the field goes read-only beside it.
       */}
      {isLeaderboardEnabled() && (
        <form className="dw-daily-row" style={{ marginTop: '0.7rem' }} onSubmit={submit}>
          <label htmlFor="dw-daily-name">Name</label>
          {/* `readOnly`, not `disabled`: Enter in the field is a submit, so the
              field is the control the player is STANDING on when the post
              lands, and disabling it would drop the keyboard to the body — the
              exact failure the note above says was fixed. Read-only spells the
              same thing out (unchangeable, still there) without leaving the
              document. `aria-describedby` ties it to the live line so a
              rejected name is read back with the field it belongs to. */}
          <input
            id="dw-daily-name"
            className="dw-daily-name"
            type="text"
            maxLength={16}
            value={alreadyPosted ? alreadyPosted.name : name}
            readOnly={Boolean(alreadyPosted)}
            aria-describedby="dw-daily-status"
            aria-invalid={status?.tone === 'error' ? 'true' : undefined}
            onInput={event => setName(event.target.value)}
          />
          {/* `type="submit"`, so Enter in the field posts; `aria-disabled`
              rather than `disabled` keeps it in the tab order while it is
              unavailable, and `post()` guards the click either way. */}
          <button
            type="submit"
            className="dw-share-btn"
            aria-disabled={pending || alreadyPosted ? 'true' : undefined}
          >
            {confirmation ?? (pending ? 'POSTING…' : 'POST')}
          </button>
        </form>
      )}
      {/*
       * The live element keeps its own line whatever it is saying, so a
       * confirmation appearing does not shove the button row below it. The
       * TEXT, not the element, is what a `quiet` outcome hides: `.sr-only`
       * clips rather than removing, so the announcement still fires — and the
       * slot the line sits in does not collapse under it.
       */}
      <p id="dw-daily-status" className={liveClass} aria-live="polite">
        <span className={status?.tone === 'quiet' ? 'sr-only' : undefined}>
          {status?.text ?? ''}
        </span>
      </p>
    </section>
  );
}

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} props.onTitle
 * @param {() => void} [props.onHistory]
 * @param {() => void} [props.onRetry] - Replay this starting board and setup.
 *   On a daily that is a PRACTICE run: the scored attempt is already spent.
 * @param {() => void} [props.onSpectate]
 * @param {() => void} [props.onRules] - Opens the "How to play" reference: the
 *   end of a game you lost is when a rule you missed is worth looking up.
 * @param {(name: string) => Promise<Object>} [props.onSubmitScore] - Post this
 *   daily result to the shared leaderboard (controller.submitDailyScore).
 */
export function GameOverScreen({
  store,
  onTitle,
  onHistory,
  onSpectate,
  onRules,
  onRetry,
  onSubmitScore,
}) {
  const gameState = useGameStore(store, s => s.gameState);
  const prefs = useGameStore(store, s => s.preferences);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const humanEliminated = useGameStore(store, s => s.humanEliminated);
  const gameOverReason = useGameStore(store, s => s.gameOverReason);
  const playerNames = useGameStore(store, s => s.playerNames);
  const journal = useGameStore(store, s => s.matchJournal);
  const daily = useGameStore(store, s => s.dailyChallenge);
  const dailyResult = useGameStore(store, s => s.dailyResult);

  const homeRef = useRef(null);
  const shareRef = useRef(null);
  const rulesOpen = useGameStore(store, s => s.rulesOpen);
  const focusClaimed = useRef(false);

  /*
   * Move focus onto this screen when it mounts: the game ends on its own, so
   * focus is sitting on the canvas or nowhere at all. It fires again on the way
   * back from the HISTORY replay viewer (goBackFromReplay remounts this
   * screen), which is what you want: the viewer's ← BACK just unmounted
   * underneath the player. Mouse users see no ring — :focus-visible only lights
   * up after keyboard input.
   *
   * WHERE it lands follows the card. HOME is the primary action of an ordinary
   * game over — the way back to setup, and on to the next game — but after a
   * scored daily the card grows a report and a share block ABOVE the button
   * row, and HOME is the last thing in the DOM. Claiming it there put COPY
   * RESULT, the name field and POST behind a Shift+Tab, and on a phone scrolled
   * the result itself off the top of the screen. So when the share block is on
   * the card, the claim goes to its first control instead; practice runs and
   * ordinary games are unchanged.
   *
   * NOT `preventScroll` either way. The card scrolls (`overflowY: auto`), so
   * the focused control can start below the fold — and a focus that refuses to
   * scroll would leave the keyboard somewhere nobody can see. Scrolling it into
   * view is the correct behaviour for a scrollable screen; the flag exists for
   * the screens where the focused control is always already visible.
   *
   * Waits out the "How to play" card: the card outlives the game ending behind
   * it (triggerGameOver deliberately leaves `rulesOpen` alone), it layers above
   * this screen and traps Tab inside itself, so pulling focus under the scrim
   * would strand the keyboard outside the trap. So the claim is made exactly
   * once — at mount if the card is down, otherwise the moment it closes — and
   * never again: a card opened later from this screen's own HOW TO PLAY hands
   * focus back to that button on close, not here. On the deferred close,
   * RulesModal's own restore runs first (it is the earlier sibling in App, so
   * its cleanup precedes this effect in the same flush) and, with the HUD's
   * RULES opener gone, aims at the first button still on screen — the settings
   * die; this effect then carries focus on to the right control here.
   *
   * Above the `!gameState` early return, so the hook order stays fixed whether
   * or not there is a terminal state to show.
   */
  useEffect(() => {
    if (rulesOpen || focusClaimed.current) return;
    focusClaimed.current = true;
    (shareRef.current ?? homeRef.current)?.focus();
  }, [rulesOpen]);

  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const winner = gameState.winner;

  // Determine heading and subtitle
  const isHumanWinner = winner !== null && winner === humanPlayerIndex;
  // The word gaps are NBSPs on purpose: the letters are spaced by hand, so a
  // plain space between the words collapses to the same width as the gap
  // between letters and the heading reads as one run.
  const heading = isHumanWinner ? 'Y O U\u00A0\u00A0W I N !' : 'G A M E\u00A0\u00A0O V E R';

  // The seat the subtitle names, if any — the one line here that belongs to a
  // particular player, so the one that gets a swatch. Null for the draw and for
  // "You were eliminated!", which are about the game rather than about a seat.
  let subtitleSeat = null;
  let subtitle = null;
  if (isHumanWinner) {
    subtitle = null; // heading says it all
  } else if (humanEliminated) {
    subtitle = 'You were eliminated!';
  } else if (winner !== null) {
    subtitle = `${playerName(playerNames, winner)} wins!`;
    subtitleSeat = winner;
  } else if (gameOverReason === 'turnLimit') {
    // No conquest before the turn cap — a stalemate (typically AI-vs-AI) ended as a draw.
    // Fires for any winnerless game that hits the cap, including a human still alive at 300.
    subtitle = 'Draw: turn limit reached';
  }

  /*
   * The scored run's own result, and the ONE place its numbers come from:
   * `dailyResult.outcome`, which the controller freezes at game over from this
   * attempt's journal and draw reason. Not recomputed here — a player who was
   * eliminated and then spectated on to a turn-cap draw would read "Draw" off
   * `winner`/`gameOverReason` while the record, the title card and the
   * leaderboard all say eliminated, and the shared text is the one copy of the
   * four that gets pasted somewhere public.
   *
   * `dailyResult.official` is the controller's verdict — false for every
   * attempt after the first — so it, not the record's mere existence, decides
   * between the share block and the practice note. The record is only consulted
   * for `submission`: storage can be unavailable (private mode, a blocked
   * origin), and a result that cannot be SAVED can still be copied, shared and
   * posted, so a null record must not take the block away.
   */
  const outcome = dailyResult?.official ? (dailyResult.outcome ?? null) : null;
  const official = dailyResult?.record?.official ?? null;
  const shareText =
    daily && outcome
      ? formatDailyShare({
          date: daily.date,
          won: Boolean(outcome.won),
          turns: outcome.turns,
          attacks: outcome.attacks,
          captures: outcome.captures,
          streak: dailyResult.streak,
          drew: Boolean(outcome.drew),
        })
      : null;

  return (
    <div className="dw-result" style={STYLE.overlay}>
      <style>{RESULT_CSS}</style>
      <div className="dw-result-spacer" />
      {daily && (
        <div className="dw-result-date">
          DAILY CONQUEST · {formatDailyDate(daily.date)}
          {daily.practice ? ' · PRACTICE' : ''}
        </div>
      )}
      {/* Always the text color: the heading used to take the winner's seat color
          on a human win, and seat 0's lavender measured 2.47:1 on the light
          panel — short of even the large-text 3:1 (#220). */}
      <h1 style={STYLE.title}>{heading}</h1>
      {subtitle && (
        <p style={STYLE.winner}>
          {subtitleSeat !== null && (
            <SeatSwatch color={colorPalette[subtitleSeat % colorPalette.length]} />
          )}
          {subtitle}
        </p>
      )}
      <MatchReport journal={journal} daily={daily} dailyResult={dailyResult} />
      {shareText && (
        <DailyShareBlock
          shareText={shareText}
          submission={official?.submission ?? null}
          onSubmitScore={onSubmitScore}
          firstControlRef={shareRef}
        />
      )}
      {daily && dailyResult && !dailyResult.official && (
        <p className="dw-result-practice">Practice run · not scored</p>
      )}
      <div style={STYLE.buttonRow}>
        <button style={STYLE.btn} onClick={onTitle} ref={homeRef}>
          HOME
        </button>
        {onRetry && (
          <button
            style={STYLE.btn}
            onClick={onRetry}
            title={
              daily
                ? 'Play today’s board again — practice runs are not scored'
                : 'Replay the same starting board and lineup'
            }
          >
            {daily ? 'PRACTICE AGAIN' : 'TRY AGAIN'}
          </button>
        )}
        {onHistory && (
          <button style={STYLE.btn} onClick={onHistory}>
            HISTORY
          </button>
        )}
        {onSpectate && humanEliminated && (
          <button style={STYLE.btn} onClick={onSpectate}>
            SPECTATE
          </button>
        )}
        {/* Muted, unlike its neighbours: HOME is what you came here to press,
            and this is a reference rather than a way on. */}
        {onRules && (
          <button
            type="button"
            style={STYLE.mutedBtn}
            onClick={onRules}
            aria-label="How to play: the rules in one card"
          >
            HOW TO PLAY
          </button>
        )}
      </div>
      <div className="dw-result-bottom" />
    </div>
  );
}
