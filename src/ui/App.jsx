/**
 * Root Application Component
 *
 * Routes between screens based on GameStore state. Renders two layers: a
 * persistent chrome layer (settings gear, plus the TopNav mode rail on the
 * hub screens) and the current screen. The chrome sits outside the screen
 * switch so it survives navigation — the rail must not remount (and replay
 * its entrance) on every tab change.
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

/** Mode-rail tab id → GameController navigation method. */
const NAV_METHODS = {
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

  /* The rail lives exactly on the hub screens (the ATTRACT_SCREENS set). */
  const isHub = NAV_TABS.some(tab => tab.id === screen);

  const content = (() => {
    if (screen === 'title') {
      return (
        <TitleScreen
          store={store}
          error={error}
          onStart={config => controller.startNewGame(config)}
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
        />
      );
    }

    if (screen === 'gameOver') {
      return (
        <div style={{ height: '100%', position: 'relative' }}>
          {announcer}
          <GameHUD store={store} />
          <GameOverScreen
            store={store}
            onTitle={() => controller.goToTitle()}
            onHistory={currentReplay ? () => controller.viewGameReplay() : undefined}
            onSpectate={() => controller.startSpectate()}
          />
        </div>
      );
    }

    // screen === 'playing'
    return (
      <div style={{ height: '100%', position: 'relative' }}>
        {announcer}
        <GameHUD store={store} />
        <GameOverlay store={store} onEndTurn={() => controller.endHumanTurn()} />
      </div>
    );
  })();

  return (
    <>
      {/*
       * Settings and the rail get separate boundaries: on the hub screens the
       * rail is the only navigation left, so a settings crash must not take
       * it down (nor vice versa).
       */}
      <ErrorBoundary>{settings}</ErrorBoundary>
      {isHub && (
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
