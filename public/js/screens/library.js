import { h } from '../core/dom.js';
import { Screen, router } from '../core/router.js';
import { store } from '../core/store.js';
import { cover, footer, header } from '../core/ui.js';
import { app } from '../app.js';
import { launchGame } from '../launcher.js';

const SORTS = [
  { id: 'recent', label: 'Recently played' },
  { id: 'title', label: 'Title' },
  { id: 'time', label: 'Play time' },
];

/** "All Software": every game in the library as a grid. */
export class LibraryScreen extends Screen {
  constructor() {
    super('library');
    this.sort = 0;
  }

  build() {
    this.grid = h('div.grid');
    this.sortLabel = h('span.badge');
    this.footer = footer([
      ['y', 'Sort'],
      ['b', 'Back'],
      ['a', 'Start'],
    ]);
    this.el.append(
      header('All Software', 'grid'),
      h('div.page-body', { data: { revealMargin: '40' } }, h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 'calc(var(--u) * 1.6)' } }, this.sortLabel), this.grid),
      this.footer,
    );
    this.cleanup(app.onChange(() => this.render()));
    this.render();
  }

  sorted() {
    const history = store.historyFor();
    const games = [...app.games];
    const id = SORTS[this.sort].id;
    if (id === 'title') return games.sort((a, b) => a.title.localeCompare(b.title));
    if (id === 'time') return games.sort((a, b) => (history[b.package]?.totalSeconds || 0) - (history[a.package]?.totalSeconds || 0));
    return app.recentGames();
  }

  render() {
    const focused = this.scope.current?.dataset.pkg;
    this.sortLabel.textContent = `Sorted by: ${SORTS[this.sort].label}`;
    this.grid.replaceChildren(
      ...this.sorted().map((game) =>
        h(
          'button.grid-item',
          { type: 'button', class: !game.devices ? 'unavailable' : '', data: { nav: '', pkg: game.package, sound: 'none' }, onclick: () => launchGame(game) },
          h('span.thumb', cover(game)),
          h('span.caption', game.title, h('small', game.publisher || (game.devices ? `${game.devices} device${game.devices === 1 ? '' : 's'}` : 'Not installed'))),
        ),
      ),
    );
    const again = focused && this.grid.querySelector(`[data-pkg="${CSS.escape(focused)}"]`);
    const target = again || this.grid.firstElementChild;
    if (router.top === this) this.scope.focus(target, { sound: false, smooth: false });
    else this.scope.current = target;
  }

  onAction(action) {
    if (action === 'y') {
      this.sort = (this.sort + 1) % SORTS.length;
      this.render();
      return true;
    }
    return false;
  }
}
