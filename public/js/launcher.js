import { app } from './app.js';
import { router } from './core/router.js';
import { store } from './core/store.js';
import { play } from './core/sound.js';
import { alert, confirm, pickUser } from './core/dialogs.js';
import { PlayerScreen } from './screens/player.js';

export async function launchGame(game) {
  if (app.running?.game.package === game.package) return resumeGame();

  if (!app.codecs.length) {
    return alert({
      title: 'Streaming isn’t available here',
      message: window.isSecureContext
        ? 'This browser can’t decode video with WebCodecs. Use a recent Chrome, Edge, Safari or Firefox.'
        : 'Video decoding only works on secure pages. Open this site over HTTPS (or on localhost).',
    });
  }
  if (!game.devices) {
    return alert({ title: 'Not available right now', message: `No online device has ${game.title} installed.` });
  }
  if (app.running) {
    const ok = await confirm({
      title: `Close ${app.running.game.title}?`,
      message: 'The software you’re playing will close. Unsaved progress will be lost.',
      confirmLabel: 'Close',
      danger: true,
    });
    if (!ok) return;
    app.running.terminate();
  }
  const users = store.state.users;
  if (users.length > 1) {
    const id = await pickUser(users, store.state.currentUser);
    if (!id) return;
    store.set('currentUser', id);
  }

  if (store.setting('fullscreen') !== false && !document.fullscreenElement) {
    document.documentElement
      .requestFullscreen?.()
      .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
      .catch(() => {});
  }
  store.recordPlay(game.package, 0);
  const player = new PlayerScreen(game);
  app.running = player;
  app.changed();
  play('launch');
  router.push(player, { transition: 'zoom' });
}

export function resumeGame() {
  if (!app.running) return;
  play('launch');
  router.push(app.running, { transition: 'zoom' });
}

export async function closeRunningGame() {
  const running = app.running;
  if (!running) return;
  const ok = await confirm({
    title: `Close ${running.game.title}?`,
    message: 'Unsaved progress will be lost.',
    confirmLabel: 'Close',
    danger: true,
  });
  if (ok && app.running === running) running.terminate();
}
