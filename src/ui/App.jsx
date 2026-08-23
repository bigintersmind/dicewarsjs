/**
 * Root Application Component
 *
 * Routes between screens based on GameStore state. Renders two layers: a
 * persistent chrome layer (settings die, plus the TopNav mode rail on the
 * hub screens other than the title) and the current screen. The chrome sits
 * outside the screen switch so it survives navigation — moving between the
 * rail screens (Arena / Tournament / Leaderboard) must not remount the rail
 * and replay its entrance. It does mount fresh on each trip out of the title,
 * which carries FooterNav instead of the rail (#182).
 *
 * @module ui/App
 */

import { lazy, Suspense } from 'preact/compat';

import { useGameStore } from './hooks/useGameStore.js';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { TitleScreen } from './TitleScreen.jsx';
import { GameHUD } from './GameHUD.jsx';
import { MapPreview } from './MapPreview.jsx';
import { GameOverlay } from './GameOverlay.jsx';
import { GameOverScreen } from './GameOverScreen.jsx';
import { QuitConfirm } from './QuitConfirm.jsx';
import { RulesModal } from './RulesModal.jsx';
import { OnlineLeaderboardScreen } from './OnlineLeaderboardScreen.jsx';
import { ReplayViewer } from './ReplayViewer.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { ScreenReaderAnnouncer } from './ScreenReaderAnnouncer.jsx';
import { TopNav, NAV_TABS } from './menuChrome.jsx';

/*
 * Arena & Tournament are the only screens that pull in the bot registry
 * (builtInBots → ai_bc/ai_ppo → the packed policy-weight modules, ~0.5 MB each).
 * Importing them statically folds those weights into the eager main bundle chunk, so
 * every page load downloads them — even for players who never open either screen
 * (issue #51). Code-split each behind a dynamic import() so the weights land in a lazy
 * chunk fetched only when the screen is actually opened. (`lazy` wants a default export;
 * both screens are named exports, hence the `.then` remap.)
 *
 * A failed chunk fetch (deploy skew rotating chunk hashes, or a network drop) rejects here
 * and is caught by ErrorBoundary, which offers a full page reload — the only real recovery,
 * since a browser caches a failed module in its module map and re-`import()`ing the same URL
 * just replays the cached rejection (issue #93).
 */
const ArenaScreen = lazy(() => import('./ArenaScreen.jsx').then(m => ({ default: m.ArenaScreen })));
const TournamentScreen = lazy(() =>
  import('./TournamentScreen.jsx').then(m => ({ default: m.TournamentScreen }))
);

/** Mode-rail / footer-row tab id → GameController navigation method. */
export const NAV_METHODS = {
  title: 'goToTitle',
  arena: 'goToArena',
  tournament: 'goToTournament',
  onlineLeaderboard: 'goToOnlineLeaderboard',
};

/**
 * Brief full-screen placeholder shown while a code-split screen chunk loads.
 * Uses the same scrim as the menu screens so the attract-mode board behind
 * stays visible and the hand-off doesn't flash a flat panel.
 */
function ScreenLoading() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--ui-scrim)',
        color: 'var(--ui-text-muted)',
        textShadow: 'var(--ui-text-halo)',
        fontSize: '1.1rem',
      }}
    >
      Loading…
    </div>
  );
}

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {Object} props.controller - GameController instance
 */
export function App({ store, controller, preferencesManager }) {
  const screen = useGameStore(store, s => s.screen);
  const error = useGameStore(store, s => s.error);
  const currentReplay = useGameStore(store, s => s.currentReplay);
  const prefs = useGameStore(store, s => s.preferences);

  if (screen === 'replay' && !currentReplay) {
    controller.goToTitle();
    return null;
  }

  const settings = preferencesManager ? (
    <SettingsPanel store={store} preferencesManager={preferencesManager} />
  ) : null;

  const announcer = <ScreenReaderAnnouncer store={store} />;

  /** Every screen's HOW TO PLAY / RULES control opens the same card. */
  const openRules = () => controller.openRules();

  /*
   * The rail lives on the hub screens (the ATTRACT_SCREENS set) minus the
   * title: the landing page reaches the same screens through TitleScreen's
   * footer row instead (#182), and the rail on each of them is the way back.
   */
  const showRail = screen !== 'title' && NAV_TABS.some(tab => tab.id === screen);

  const content = (() => {
    if (screen === 'title') {
      return (
        <TitleScreen
          store={store}
          error={error}
          onStart={config => controller.startNewGame(config)}
          onNavigate={id => controller[NAV_METHODS[id]]()}
          onRules={openRules}
        />
      );
    }

    if (screen === 'arena') {
      return (
        <Suspense fallback={<ScreenLoading />}>
          <ArenaScreen onViewReplay={replay => controller.goToReplay(replay)} />
        </Suspense>
      );
    }

    if (screen === 'tournament') {
      return (
        <Suspense fallback={<ScreenLoading />}>
          <TournamentScreen onViewReplay={replay => controller.goToReplay(replay)} />
        </Suspense>
      );
    }

    if (screen === 'onlineLeaderboard') {
      return <OnlineLeaderboardScreen onViewReplay={replay => controller.goToReplay(replay)} />;
    }

    if (screen === 'replay') {
      return (
        <ReplayViewer
          replay={currentReplay}
          onStateChange={state => controller.updateReplayBoard(state)}
          onBack={() => controller.goBackFromReplay()}
          overlay={true}
        />
      );
    }

    if (screen === 'mapPreview') {
      return (
        <MapPreview
          store={store}
          onAccept={() => controller.acceptMap()}
          onReject={() => controller.rejectMap()}
          onBack={() => controller.goToTitle()}
        />
      );
    }

    if (screen === 'gameOver') {
      return (
        <div style={{ height: '100%', position: 'relative' }}>
          {announcer}
          {/* No onRules here: GameOverScreen's overlay covers the whole HUD, so
              a control in the bar would be unreachable. The screen carries its
              own HOW TO PLAY instead. */}
          <GameHUD store={store} />
          <GameOverScreen
            store={store}
            onTitle={() => controller.goToTitle()}
            onHistory={currentReplay ? () => controller.viewGameReplay() : undefined}
            onSpectate={() => controller.startSpectate()}
            onRules={openRules}
          />
        </div>
      );
    }

    // screen === 'playing'
    return (
      <div style={{ height: '100%', position: 'relative' }}>
        {announcer}
        <GameHUD store={store} onQuit={() => controller.openQuitConfirm()} onRules={openRules} />
        <GameOverlay store={store} onEndTurn={() => controller.endHumanTurn()} />
        {/* Mounted whether or not the dialog is up: it also owns Escape (#181). */}
        <QuitConfirm
          store={store}
          onOpen={() => controller.openQuitConfirm()}
          onCancel={() => controller.closeQuitConfirm()}
          onConfirm={() => controller.goToTitle()}
        />
      </div>
    );
  })();

  return (
    <>
      {/*
       * Settings and the rail get separate boundaries: on the hub screens other
       * than the title the rail is the only navigation left, so a settings crash
       * must not take it down (nor vice versa). The title's own way out is the
       * footer row, which lives inside the screen's boundary.
       */}
      <ErrorBoundary>{settings}</ErrorBoundary>
      {/*
       * Outside the screen switch like the settings die: the reference opens
       * over any screen, and it must not be torn down by a screen change
       * happening behind it (a game ending while the player reads). Mounted
       * whether or not the card is up — it also owns Escape while it is.
       */}
      <ErrorBoundary>
        <RulesModal store={store} onClose={() => controller.closeRules()} />
      </ErrorBoundary>
      {showRail && (
        <ErrorBoundary>
          <TopNav
            active={screen}
            animate={prefs?.reducedMotion !== 'on'}
            onNavigate={id => controller[NAV_METHODS[id]]()}
          />
        </ErrorBoundary>
      )}
      {/* Keyed by screen so a crash caught on one screen never sticks to the next. */}
      <ErrorBoundary key={screen}>{content}</ErrorBoundary>
    </>
  );
}
