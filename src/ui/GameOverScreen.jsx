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
import { isLeaderboardEnabled } from '../game/dailyLeaderboard.js';
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
  border: 2px solid var(--ui-border); border-radius: 6px; cursor: pointer; }
.dw-share-btn:hover { border-color: var(--ui-accent); }
.dw-share-btn:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.dw-share-btn[aria-disabled='true'] { opacity: .55; cursor: default; }
.dw-daily-name { font-family: Roboto, sans-serif; font-size: .9rem; padding: .4rem .5rem;
  min-width: 9rem; color: var(--ui-text); background: var(--ui-panel-bg);
  border: 1px solid var(--ui-border); border-radius: 6px; }
.dw-share-text { width: 100%; margin-top: .5rem; font-family: Roboto, sans-serif;
  font-size: .8rem; line-height: 1.5; padding: .4rem .5rem; color: var(--ui-text);
  background: var(--ui-panel-bg); border: 1px solid var(--ui-border); border-radius: 6px; }
@media (pointer: coarse) {
  .dw-share-btn { min-height: 44px; }
  .dw-daily-name { min-height: 44px; }
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
 * The share/post block for a scored daily result: COPY RESULT (and SHARE where
 * the platform has a share sheet), then the leaderboard form.
 *
 * The clipboard is not assumed. `navigator.clipboard` is absent outside secure
 * contexts and `writeText` can reject on a permission prompt, so either one
 * falls back to a readonly textarea holding the same text, selected and ready
 * to copy by hand — the result is never unreachable.
 *
 * @param {Object} props
 * @param {string} props.shareText - The pasteable result (dailyShare.js)
 * @param {Object | null} props.submission - record.official.submission, if posted
 * @param {(name: string) => Promise<Object>} [props.onSubmitScore]
 */
function DailyShareBlock({ shareText, submission, onSubmitScore }) {
  const [copied, setCopied] = useState(false);
  const [showText, setShowText] = useState(false);
  const [name, setName] = useState(readRememberedName);
  const [pending, setPending] = useState(false);
  const [posted, setPosted] = useState(null);
  const [error, setError] = useState(null);
  const textRef = useRef(null);
  const copiedTimer = useRef(null);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const revealText = () => {
    setShowText(true);
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
        setCopied(true);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch(revealText);
  };

  const share = () => {
    try {
      // A cancelled share sheet rejects; that is the user saying no, not an error.
      Promise.resolve(navigator.share({ text: shareText })).catch(() => {});
    } catch {
      /* No share target after all — the copy button beside it is the way out. */
    }
  };

  const post = () => {
    if (pending || !onSubmitScore) return;
    setPending(true);
    setError(null);
    const fail = err => {
      setError(err?.message || 'Could not post your result.');
      setPending(false);
    };
    let submitted;
    try {
      submitted = onSubmitScore(name);
    } catch (err) {
      fail(err);
      return;
    }
    Promise.resolve(submitted)
      .then(result => {
        rememberName(name);
        setPosted(result ?? {});
        setPending(false);
      })
      .catch(fail);
  };

  const alreadyPosted = submission ?? posted;

  return (
    <section className="dw-daily-actions" aria-labelledby="dw-daily-actions-title">
      <h2 id="dw-daily-actions-title">Your result</h2>
      <div className="dw-daily-row">
        <button type="button" className="dw-share-btn" onClick={copy}>
          COPY RESULT
          {/* The confirmation lives inside the button's own name rather than in
              a second live region: this screen already has exactly one
              `role="status"` (App's ScreenReaderAnnouncer), and two live
              regions on one screen race each other. */}
          <span aria-live="polite">{copied ? ' · Copied' : ''}</span>
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
      {isLeaderboardEnabled() &&
        (alreadyPosted ? (
          <p>
            Posted as {submission?.name ?? name}
            {alreadyPosted.rank ? ` · #${alreadyPosted.rank}` : ''}
          </p>
        ) : (
          <>
            <div className="dw-daily-row" style={{ marginTop: '0.7rem' }}>
              <label htmlFor="dw-daily-name">Name</label>
              <input
                id="dw-daily-name"
                className="dw-daily-name"
                type="text"
                maxLength={16}
                value={name}
                onInput={event => setName(event.target.value)}
              />
              <button
                type="button"
                className="dw-share-btn"
                onClick={post}
                aria-disabled={pending ? 'true' : undefined}
              >
                {pending ? 'POSTING…' : 'POST'}
              </button>
            </div>
            {error && <p>{error}</p>}
          </>
        ))}
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
  const rulesOpen = useGameStore(store, s => s.rulesOpen);
  const focusClaimed = useRef(false);

  /*
   * Move focus to HOME when this screen mounts: the game ends on its own, so
   * focus is sitting on the canvas or nowhere at all, and HOME is the primary
   * action here — the way back to setup, and on to the next game. It fires
   * again on the way back from the HISTORY replay viewer (goBackFromReplay
   * remounts this screen), which is what you want: the viewer's ← BACK just
   * unmounted underneath the player. Mouse users see no ring — :focus-visible
   * only lights up after keyboard input.
   *
   * NOT `preventScroll` any more. The card scrolls now (`overflowY: auto`, and
   * on a daily it carries the match report and the share block above the
   * buttons), so on a short window HOME can be below the fold — and a focus
   * that deliberately refuses to scroll would leave the keyboard on a control
   * nobody can see. Scrolling it into view is the correct behaviour for a
   * scrollable screen; the flag exists for the screens where the focused
   * control is always already on screen.
   *
   * Waits out the "How to play" card: the card outlives the game ending behind
   * it (triggerGameOver deliberately leaves `rulesOpen` alone), it layers above
   * this screen and traps Tab inside itself, so pulling focus to HOME under
   * the scrim would strand the keyboard outside the trap. So the claim is made
   * exactly once — at mount if the card is down, otherwise the moment it
   * closes — and never again: a card opened later from this screen's own
   * HOW TO PLAY hands focus back to that button on close, not here. On the
   * deferred close, RulesModal's own restore runs first (it is the earlier
   * sibling in App, so its cleanup precedes this effect in the same flush) and,
   * with the HUD's RULES opener gone, aims at the first button still on
   * screen — the settings die; this effect then carries focus on to HOME.
   *
   * Above the `!gameState` early return, so the hook order stays fixed whether
   * or not there is a terminal state to show.
   */
  useEffect(() => {
    if (rulesOpen || focusClaimed.current) return;
    focusClaimed.current = true;
    homeRef.current?.focus();
  }, [rulesOpen]);

  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const winner = gameState.winner;

  // Determine heading and subtitle
  const isHumanWinner = winner !== null && winner === humanPlayerIndex;
  const heading = isHumanWinner ? 'Y O U  W I N !' : 'G A M E  O V E R';

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
   * The scored run's own result. `dailyResult.official` is the controller's
   * verdict — false for every attempt after the first — so it, not the record's
   * mere existence, is what decides between the share block and the practice
   * note. The draw flag comes from this game rather than from the record: the
   * screen already knows how the game ended, and the stored result carries only
   * won/turns.
   */
  const official = dailyResult?.official ? (dailyResult.record?.official ?? null) : null;
  const drew = winner === null && gameOverReason === 'turnLimit';
  const shareText =
    daily && official
      ? formatDailyShare({
          date: daily.date,
          won: Boolean(official.won),
          turns: official.turns,
          attacks: official.attacks,
          captures: official.captures,
          streak: dailyResult.streak,
          drew,
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
          submission={official.submission ?? null}
          onSubmitScore={onSubmitScore}
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
