import { h, svgIcon } from '../core/dom.js';
import { Screen, router } from '../core/router.js';
import { store } from '../core/store.js';
import { input } from '../core/input.js';
import { play } from '../core/sound.js';
import { avatar, cover, footer, statusCluster } from '../core/ui.js';
import { app } from '../app.js';
import { launchGame, closeRunningGame } from '../launcher.js';
import { LibraryScreen } from './library.js';
import { SettingsScreen } from './settings.js';
import { AlbumScreen } from './album.js';
import { ControllersScreen } from './controllers.js';
import { StoreScreen } from './store.js';
import { StatusScreen } from './status.js';
import { ProfileScreen } from './profile.js';

const MAX_TILES = 12;

const DOCK = [
  { id: 'news', label: 'Network Status', icon: 'news', color: '#ec4a3c', open: () => new StatusScreen() },
  { id: 'shop', label: 'Game Store', icon: 'shop', color: '#f39324', open: () => new StoreScreen() },
  { id: 'album', label: 'Album', icon: 'album', color: '#2c96ee', open: () => new AlbumScreen() },
  { id: 'controllers', label: 'Controllers', icon: 'controller', color: '#17b7a0', open: () => new ControllersScreen() },
  { id: 'settings', label: 'System Settings', icon: 'settings', color: '#8a8f98', open: () => new SettingsScreen() },
  { id: 'sleep', label: 'Sleep Mode', icon: 'power', color: '#8a8f98', open: null },
];

export class HomeScreen extends Screen {
  constructor({ onSleep }) {
    super('home');
    this.onSleep = onSleep;
  }

  build() {
    this.userBtn = h('button.home-user', {
      type: 'button',
      data: { nav: '', navGroup: 'top' },
      onclick: () => router.push(new ProfileScreen()),
    });
    this.row = h('div.tile-row', { data: { revealMargin: '60' } });
    this.empty = h('div.home-empty');
    this.dock = h(
      'nav.dock',
      DOCK.map((d) =>
        h(
          'button.dock-btn',
          {
            type: 'button',
            style: { '--dock': d.color },
            data: { nav: '', navGroup: 'dock', dock: d.id },
            'aria-label': d.label,
            onclick: () => this.openDock(d),
          },
          h('span.dock-circle', svgIcon(d.icon)),
          h('span.dock-label', d.label),
        ),
      ),
    );
    this.footer = footer([['a', 'Start']]);
    this.el.append(h('header.home-top', this.userBtn, statusCluster()), this.row, this.empty, this.dock, this.footer);

    this.el.addEventListener('nav:focus', (e) => this.updateHints(e.target));
    app.onChange(() => this.render());
    store.subscribe((key) => (key === 'users' || key === 'currentUser' || key === 'history') && this.render());
    this.render();
  }

  render() {
    const user = store.user;
    this.userBtn.replaceChildren(avatar(user, 'lg'), h('span.home-user-name', user.name));

    const focusedPkg = this.scope.current?.dataset.pkg;
    let games = app.recentGames();
    const running = app.running?.game;
    if (running) games = [app.game(running.package) || running, ...games.filter((g) => g.package !== running.package)];
    const shown = games.slice(0, MAX_TILES);

    const tiles = shown.map((game, i) => {
      const isRunning = running?.package === game.package;
      return h(
        'button.tile',
        {
          type: 'button',
          class: [isRunning ? 'running' : '', !game.devices ? 'unavailable' : ''].join(' '),
          data: { nav: '', navGroup: 'tiles', pkg: game.package, sound: 'none', ...(i === 0 ? { navDefault: '' } : {}) },
          'aria-label': game.title,
          onclick: (e) => this.activateTile(e.currentTarget, () => launchGame(game)),
        },
        cover(game),
        h('span.tile-label', game.title),
        isRunning && h('span.tile-badge', svgIcon('play'), 'Suspended'),
      );
    });
    if (app.games.length) {
      tiles.push(
        h(
          'button.tile.tile-all',
          { type: 'button', data: { nav: '', navGroup: 'tiles', pkg: '__all' }, onclick: (e) => this.activateTile(e.currentTarget, () => router.push(new LibraryScreen())) },
          h('span.tile-all-inner', svgIcon('grid'), h('span', 'All Software')),
          h('span.tile-label', 'All Software'),
        ),
      );
    }
    this.row.replaceChildren(...tiles);

    if (!app.games.length) {
      const err = app.gamesError;
      this.empty.replaceChildren(
        h('div.home-empty-card',
          svgIcon(err ? 'wifi' : 'gift'),
          h('h2', err ? (err.status === 401 ? 'Access code needed' : 'Can’t reach the server') : 'No games yet'),
          h('p', err ? (err.status === 401 ? 'Enter the access code in System Settings › Server.' : err.message) : 'Install free games from the Game Store, or add your own APKs.'),
          h('button.pill-btn', { type: 'button', data: { nav: '', navDefault: '' }, onclick: () => router.push(err?.status === 401 ? new SettingsScreen('server') : new StoreScreen()) }, err?.status === 401 ? 'Open Settings' : 'Open Game Store'),
        ),
      );
      this.empty.hidden = false;
    } else {
      this.empty.hidden = true;
    }

    const current = this.scope.current;
    if (!current || !current.isConnected) {
      const again = focusedPkg && this.row.querySelector(`[data-pkg="${CSS.escape(focusedPkg)}"]`);
      const target = again || this.row.firstElementChild || this.empty.querySelector('[data-nav]') || this.dock.firstElementChild;
      if (router.top === this && !router.dialogs.length) this.scope.focus(target, { sound: false, smooth: false });
      else this.scope.current = target;
    }
  }

  // Like a handheld console: the first tap selects a tile, a second tap opens it.
  activateTile(el, open) {
    if (input.source === 'touch' && this.scope.current !== el) {
      this.scope.focus(el);
      return;
    }
    open();
  }

  updateHints(el) {
    if (!el?.closest) return;
    if (el.classList.contains('tile') && el.dataset.pkg !== '__all') {
      const hints = [['a', el.classList.contains('running') ? 'Resume' : 'Start']];
      if (el.classList.contains('running')) hints.unshift(['x', 'Close Software']);
      this.footer.setHints(hints);
    } else {
      this.footer.setHints([['a', 'OK']]);
    }
  }

  onShow() {
    this.render();
    app.refreshGames();
  }

  openDock(d) {
    if (d.id === 'sleep') return this.onSleep();
    router.push(d.open());
  }

  onAction(action) {
    const el = this.scope.current;
    if (action === 'x' && el?.classList.contains('running')) {
      closeRunningGame();
      return true;
    }
    if (action === 'home') {
      const first = this.row.firstElementChild;
      if (first) this.scope.focus(first);
      play('home');
      return true;
    }
    if (action === 'b') return true;
    if (action === 'plus') {
      router.push(new SettingsScreen());
      return true;
    }
    return false;
  }
}
