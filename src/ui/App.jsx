/**
 * Root Application Component
 *
 * Routes between screens based on GameStore state.
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

  const settings = preferencesManager ? (
    <SettingsPanel store={store} preferencesManager={preferencesManager} />
  ) : null;

  const announcer = <ScreenReaderAnnouncer store={store} />;

  if (screen === 'title') {
    return (
      <ErrorBoundary>
        {settings}
        <TitleScreen
          store={store}
          error={error}
          onStart={config => controller.startNewGame(config)}
          onArena={() => controller.goToArena()}
          onTournament={() => controller.goToTournament()}
          onLeaderboard={() => controller.goToOnlineLeaderboard()}
        />
      </ErrorBoundary>
    );
  }

  if (screen === 'arena') {
    return (
      <ErrorBoundary>
        {settings}
        <Suspense fallback={<ScreenLoading />}>
          <ArenaScreen
            onBack={() => controller.goToTitle()}
            onViewReplay={replay => controller.goToReplay(replay)}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (screen === 'tournament') {
    return (
      <ErrorBoundary>
        {settings}
        <Suspense fallback={<ScreenLoading />}>
          <TournamentScreen
            onBack={() => controller.goToTitle()}
            onViewReplay={replay => controller.goToReplay(replay)}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (screen === 'onlineLeaderboard') {
    return (
      <ErrorBoundary>
        {settings}
        <OnlineLeaderboardScreen
          onBack={() => controller.goToTitle()}
          onViewReplay={replay => controller.goToReplay(replay)}
        />
      </ErrorBoundary>
    );
  }

  if (screen === 'replay') {
    if (!currentReplay) {
      controller.goToTitle();
      return null;
    }
    return (
      <ErrorBoundary>
        {settings}
        <ReplayViewer
          replay={currentReplay}
          onStateChange={state => controller.updateReplayBoard(state)}
          onBack={() => controller.goBackFromReplay()}
          overlay={true}
        />
      </ErrorBoundary>
    );
  }

  if (screen === 'mapPreview') {
    return (
      <ErrorBoundary>
        {settings}
        <MapPreview
          store={store}
          onAccept={() => controller.acceptMap()}
          onReject={() => controller.rejectMap()}
        />
      </ErrorBoundary>
    );
  }

  if (screen === 'gameOver') {
    return (
      <ErrorBoundary>
        {settings}
        {announcer}
        <div style={{ height: '100%', position: 'relative' }}>
          <GameHUD store={store} />
          <GameOverScreen
            store={store}
            onTitle={() => controller.goToTitle()}
            onHistory={currentReplay ? () => controller.viewGameReplay() : undefined}
            onSpectate={() => controller.startSpectate()}
          />
        </div>
      </ErrorBoundary>
    );
  }

  // screen === 'playing'
  return (
    <ErrorBoundary>
      {settings}
      {announcer}
      <div style={{ height: '100%', position: 'relative' }}>
        <GameHUD store={store} />
        <GameOverlay store={store} onEndTurn={() => controller.endHumanTurn()} />
      </div>
    </ErrorBoundary>
  );
}
