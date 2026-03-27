/**
 * Root Application Component
 *
 * Routes between screens based on GameStore state.
 *
 * @module ui/App
 */

import { useGameStore } from './hooks/useGameStore.js';
import { TitleScreen } from './TitleScreen.jsx';
import { GameHUD } from './GameHUD.jsx';
import { MapPreview } from './MapPreview.jsx';
import { GameOverlay } from './GameOverlay.jsx';
import { GameOverScreen } from './GameOverScreen.jsx';

/**
 * @param {Object} props
 * @param {import('../store/GameStore.js').GameStore} props.store
 * @param {import('../controller/GameController.js').GameController} props.controller
 */
export function App({ store, controller }) {
  const screen = useGameStore(store, s => s.screen);

  if (screen === 'title') {
    return <TitleScreen onStart={config => controller.startNewGame(config)} />;
  }

  if (screen === 'mapPreview') {
    return (
      <MapPreview onAccept={() => controller.acceptMap()} onReject={() => controller.rejectMap()} />
    );
  }

  if (screen === 'gameOver') {
    return (
      <div style={{ height: '100%', position: 'relative' }}>
        <GameHUD store={store} />
        <GameOverScreen store={store} onTitle={() => controller.goToTitle()} />
      </div>
    );
  }

  // screen === 'playing'
  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <GameHUD store={store} />
      <GameOverlay store={store} onEndTurn={() => controller.endHumanTurn()} />
    </div>
  );
}
