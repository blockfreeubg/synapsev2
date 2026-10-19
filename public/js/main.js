import { router } from './core/router.js';
import { store } from './core/store.js';
import { input } from './core/input.js';
import { unlockAudio } from './core/sound.js';
import { mountToasts, toast } from './core/ui.js';
import { prompt } from './core/dialogs.js';
import { api } from './core/api.js';
import { wait } from './core/dom.js';
import { app } from './app.js';
import { opusSupported, supportedVideoCodecs } from './stream/codecs.js';
import { BootScreen, LockScreen } from './screens/lock.js';
import { HomeScreen } from './screens/home.js';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const theme = store.setting('theme');
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#2d2d2d' : '#ebebeb');
}

async function askAccessCode() {
  const code = await prompt({ title: 'Access code', message: 'This server needs an access code to play.', type: 'password' });
  if (!code) return;
  store.set('accessCode', code);
  await app.refreshGames();
  if (app.gamesError?.status === 401) toast('That access code was not accepted', { icon: 'lock', sound: 'error' });
}

async function main() {
  applyTheme();
  store.subscribe((key) => key === 'settings' && applyTheme());
  darkQuery.addEventListener?.('change', applyTheme);

  document.documentElement.dataset.input = 'mouse';
  router.mount(document.getElementById('screens'), document.getElementById('layer-dialog'));
  mountToasts(document.getElementById('layer-toast'));
  // Browsers only allow audio after a gesture; every tap or key press counts.
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);

  router.replaceAll(new BootScreen('Synapse'), { transition: null });
  const [info, codecs, opus] = await Promise.all([
    api('/api/info').catch(() => null),
    supportedVideoCodecs(),
    opusSupported(),
    wait(1600),
  ]);
  app.info = info;
  app.codecs = codecs;
  app.opus = opus;
  if (info?.name) document.title = info.name;
  await app.refreshGames();

  const home = new HomeScreen({ onSleep: () => router.replaceAll(lock, { transition: 'fade' }) });
  const goHome = () => {
    router.replaceAll(home, { transition: 'fade' });
    if (app.gamesError?.status === 401) setTimeout(askAccessCode, 300);
  };
  const lock = new LockScreen(goHome);
  if (store.setting('lockScreen')) router.replaceAll(lock, { transition: 'fade' });
  else goHome();

  input.onPadChange((type) => toast(type === 'connected' ? 'Controller connected' : 'Controller disconnected', { icon: 'controller' }));
  setInterval(() => {
    if (router.top === home && !document.hidden) app.refreshGames();
  }, 20_000);
}

main();
