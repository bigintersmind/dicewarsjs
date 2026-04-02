/**
 * Root Application Component
 *
 * Routes between screens based on GameStore state.
 *
 * @module ui/App
 */

import { useGameStore } from './hooks/useGameStore.js';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { TitleScreen } from './TitleScreen.jsx';
import { GameHUD } from './GameHUD.jsx';
import { MapPreview } from './MapPreview.jsx';
import { GameOverlay } from './GameOverlay.jsx';
import { GameOverScreen } from './GameOverScreen.jsx';
import { ArenaScreen } from './ArenaScreen.jsx';
import { TournamentScreen } from './TournamentScreen.jsx';
import { OnlineLeaderboardScreen } from './OnlineLeaderboardScreen.jsx';
import { ReplayViewer } from './ReplayViewer.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { ScreenReaderAnnouncer } from './ScreenReaderAnnouncer.jsx';

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
        <ArenaScreen
          onBack={() => controller.goToTitle()}
          onViewReplay={replay => controller.goToReplay(replay)}
        />
      </ErrorBoundary>
    );
  }

  if (screen === 'tournament') {
    return (
      <ErrorBoundary>
        {settings}
        <TournamentScreen
          onBack={() => controller.goToTitle()}
          onViewReplay={replay => controller.goToReplay(replay)}
        />
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
