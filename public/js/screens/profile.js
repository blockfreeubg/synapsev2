import { h, svgIcon, formatDuration, timeAgo } from '../core/dom.js';
import { Screen, router } from '../core/router.js';
import { store, USER_COLORS } from '../core/store.js';
import { confirm, prompt } from '../core/dialogs.js';
import { avatar, cover, footer, header, toast } from '../core/ui.js';
import { app } from '../app.js';

export class ProfileScreen extends Screen {
  constructor(userId = store.state.currentUser) {
    super('profile');
    this.userId = userId;
  }

  get user() {
    return store.state.users.find((u) => u.id === this.userId);
  }

  build() {
    this.body = h('div.page-body', { data: { revealMargin: '40' } });
    this.el.append(header('User Page', 'user'), this.body, footer([['b', 'Back'], ['a', 'OK']]));
    this.cleanup(store.subscribe(() => this.render()));
    this.render();
  }

  render() {
    const user = this.user;
    if (!user) return;
    const focused = this.scope.current?.dataset.row;
    const isCurrent = user.id === store.state.currentUser;
    const history = Object.entries(store.historyFor(user.id))
      .filter(([, v]) => v.totalSeconds > 0)
      .sort((a, b) => b[1].lastPlayed - a[1].lastPlayed);
    const total = history.reduce((sum, [, v]) => sum + v.totalSeconds, 0);

    const row = (id, label, onClick, extra = {}) =>
      h('button.row', { type: 'button', class: extra.danger ? 'danger' : '', data: { nav: '', row: id }, onclick: onClick }, extra.icon && svgIcon(extra.icon, 'lead'), h('span.row-main', label), extra.value && h('span.row-value', extra.value));

    this.body.replaceChildren(
      h('div.profile-head', avatar(user, 'xxl'), h('div', h('h2', user.name), h('p', isCurrent ? 'Playing now' : 'Not the current user'), h('p', `Total play time: ${formatDuration(total)}`))),
      h(
        'div.rows',
        !isCurrent &&
          row('switch', `Play as ${user.name}`, () => {
            store.set('currentUser', user.id);
            toast(`Now playing as ${user.name}`, { icon: 'user' });
          }, { icon: 'user' }),
        row('name', 'Change nickname', async () => {
          const name = await prompt({ title: 'Nickname', value: user.name, maxLength: 20 });
          if (name) store.updateUser(user.id, { name });
        }, { icon: 'edit', value: user.name }),
        store.state.users.length > 1 &&
          row('delete', 'Delete this user', async () => {
            const ok = await confirm({ title: `Delete ${user.name}?`, message: 'Their play activity in this browser will be deleted too.', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            store.removeUser(user.id);
            router.back();
          }, { icon: 'trash', danger: true }),
      ),
      h('h2.section-title', 'Icon color'),
      h(
        'div.color-swatches',
        USER_COLORS.map((c) =>
          h('button.swatch', {
            type: 'button',
            class: c === user.color ? 'selected' : '',
            style: { '--swatch': c },
            'aria-label': `Color ${c}`,
            data: { nav: '', row: `color-${c}`, sound: 'toggle' },
            onclick: () => store.updateUser(user.id, { color: c }),
          }),
        ),
      ),
      h('h2.section-title', 'Play activity'),
      history.length
        ? h(
            'div.rows',
            history.map(([pkg, v]) => {
              const game = app.game(pkg) || { package: pkg, title: pkg.split('.').pop() };
              return h(
                'div.row.activity',
                h('span.thumb', cover(game)),
                h('span.row-main', h('span', game.title), h('span.row-sub', `Played ${formatDuration(v.totalSeconds)} · Last played ${timeAgo(v.lastPlayed)}`)),
              );
            }),
          )
        : h('p.note', 'No play activity yet.'),
    );
    const again = focused && this.body.querySelector(`[data-row="${CSS.escape(focused)}"]`);
    if (again && router.top === this) this.scope.focus(again, { sound: false, scroll: false });
  }
}
