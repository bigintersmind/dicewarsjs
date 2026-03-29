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

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {Object} props.controller - GameController instance
 */
export function App({ store, controller }) {
  const screen = useGameStore(store, s => s.screen);
  const error = useGameStore(store, s => s.error);

  if (screen === 'title') {
    return (
      <ErrorBoundary>
        <TitleScreen
          error={error}
          onStart={config => controller.startNewGame(config)}
          onArena={() => controller.goToArena()}
          onTournament={() => controller.goToTournament()}
        />
      </ErrorBoundary>
    );
  }

  if (screen === 'arena') {
    return (
      <ErrorBoundary>
        <ArenaScreen onBack={() => controller.goToTitle()} />
      </ErrorBoundary>
    );
  }

  if (screen === 'tournament') {
    return (
      <ErrorBoundary>
        <TournamentScreen onBack={() => controller.goToTitle()} />
      </ErrorBoundary>
    );
  }

  if (screen === 'mapPreview') {
    return (
      <ErrorBoundary>
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
        <div style={{ height: '100%', position: 'relative' }}>
          <GameHUD store={store} />
          <GameOverScreen store={store} onTitle={() => controller.goToTitle()} />
        </div>
      </ErrorBoundary>
    );
  }

  // screen === 'playing'
  return (
    <ErrorBoundary>
      <div style={{ height: '100%', position: 'relative' }}>
        <GameHUD store={store} />
        <GameOverlay store={store} onEndTurn={() => controller.endHumanTurn()} />
      </div>
    </ErrorBoundary>
  );
}
