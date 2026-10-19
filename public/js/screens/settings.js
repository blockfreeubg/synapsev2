import { h, svgIcon } from '../core/dom.js';
import { Screen, router } from '../core/router.js';
import { store } from '../core/store.js';
import { play } from '../core/sound.js';
import { api } from '../core/api.js';
import { alert, choose, confirm, prompt } from '../core/dialogs.js';
import { avatar, footer, header, toast } from '../core/ui.js';
import { app } from '../app.js';
import { QUALITY } from '../stream/quality.js';
import { ProfileScreen } from './profile.js';
import { ControllersScreen } from './controllers.js';

const CATEGORIES = [
  { id: 'themes', label: 'Themes', icon: 'palette' },
  { id: 'sound', label: 'Sound', icon: 'volume' },
  { id: 'streaming', label: 'Streaming', icon: 'monitor' },
  { id: 'controls', label: 'Controls', icon: 'controller' },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'server', label: 'Server', icon: 'server' },
  { id: 'system', label: 'System', icon: 'settings' },
];

const THEMES = [
  { value: 'light', label: 'Basic White' },
  { value: 'dark', label: 'Basic Black' },
  { value: 'system', label: 'Match device', desc: 'Follow the light/dark setting of this device' },
];

function row({ icon, label, sub, value, toggle, onClick, danger, id }) {
  return h(
    'button.row',
    { type: 'button', class: danger ? 'danger' : '', data: { nav: '', navGroup: 'rows', row: id || label, sound: toggle !== undefined ? 'toggle' : 'select' }, onclick: onClick },
    icon && svgIcon(icon, 'lead'),
    h('span.row-main', h('span', label), sub && h('span.row-sub', sub)),
    value !== undefined && h('span.row-value', value),
    toggle !== undefined && h('span.toggle', { class: toggle ? 'on' : '' }),
  );
}

export class SettingsScreen extends Screen {
  constructor(initial = 'themes') {
    super('settings');
    this.category = initial;
  }

  build() {
    this.nav = h(
      'nav.split-nav',
      CATEGORIES.map((c) =>
        h(
          'button',
          {
            type: 'button',
            data: { nav: '', navGroup: 'cats', cat: c.id, sound: 'none', ...(c.id === this.category ? { navDefault: '' } : {}) },
            onclick: () => this.enterContent(),
          },
          svgIcon(c.icon),
          c.label,
        ),
      ),
    );
    this.content = h('div.split-content', { data: { revealMargin: '30' } });
    this.el.append(header('System Settings', 'settings'), h('div.split', this.nav, this.content), footer([['b', 'Back'], ['a', 'OK']]));

    this.el.addEventListener('nav:focus', (e) => {
      const cat = e.target.dataset?.cat;
      if (cat && cat !== this.category) {
        this.category = cat;
        this.render();
      }
    });
    this.cleanup(store.subscribe(() => this.render()));
    this.render();
  }

  enterContent() {
    const first = this.content.querySelector('[data-nav]');
    if (first) this.scope.focus(first);
  }

  render() {
    for (const b of this.nav.children) b.classList.toggle('active', b.dataset.cat === this.category);
    const focusedRow = this.content.contains(this.scope.current) ? this.scope.current.dataset.row : null;
    this.content.replaceChildren(...this[`render_${this.category}`]());
    if (focusedRow) {
      const again = [...this.content.querySelectorAll('[data-row]')].find((el) => el.dataset.row === focusedRow) || this.content.querySelector('[data-nav]');
      if (again) this.scope.focus(again, { sound: false, scroll: false });
    }
  }

  async pick(title, options, key) {
    const value = await choose({ title, options, value: store.setting(key) });
    if (value !== null && value !== undefined) store.setSetting(key, value);
  }

  toggle(key) {
    store.setSetting(key, !store.setting(key));
  }

  render_themes() {
    const theme = THEMES.find((t) => t.value === store.setting('theme'));
    return [
      h('h2.section-title', 'Theme'),
      h('div.rows', row({ label: 'Theme', value: theme?.label, onClick: () => this.pick('Theme', THEMES, 'theme') })),
      h('p.note', 'Basic White and Basic Black change the colors of the HOME Menu and every page.'),
    ];
  }

  render_sound() {
    const volumes = [
      { value: 0.25, label: 'Quiet' },
      { value: 0.5, label: 'Medium' },
      { value: 0.7, label: 'Normal' },
      { value: 1, label: 'Loud' },
    ];
    const vol = volumes.find((v) => v.value === store.setting('volume')) || volumes[2];
    return [
      h('h2.section-title', 'Interface sounds'),
      h(
        'div.rows',
        row({ label: 'Menu sounds', sub: 'Clicks and chimes when navigating', toggle: store.setting('sounds'), onClick: () => this.toggle('sounds') }),
        row({ label: 'Menu sound volume', value: vol.label, onClick: () => this.pick('Menu sound volume', volumes, 'volume') }),
      ),
      h('h2.section-title', 'Game audio'),
      h(
        'div.rows',
        row({
          label: 'Stream game audio',
          sub: app.opus ? 'Opus audio from the device (Android 11+)' : 'This browser can’t decode Opus audio',
          toggle: store.setting('audio') && app.opus,
          onClick: () => (app.opus ? this.toggle('audio') : null),
        }),
      ),
    ];
  }

  render_streaming() {
    const q = QUALITY[store.setting('quality')] || QUALITY.balanced;
    const qualities = Object.entries(QUALITY).map(([value, v]) => ({ value, label: v.label, desc: v.desc }));
    const fpsOptions = [
      { value: 30, label: '30 fps', desc: 'Lower bandwidth and device load' },
      { value: 60, label: '60 fps', desc: 'Smoothest motion' },
    ];
    const codecs = app.codecs.length ? app.codecs.map((c) => c.toUpperCase()).join(', ') : 'none';
    return [
      h('h2.section-title', 'Picture'),
      h(
        'div.rows',
        row({ label: 'Stream quality', sub: q.desc, value: q.label, onClick: () => this.pick('Stream quality', qualities, 'quality') }),
        row({ label: 'Frame rate', value: `${store.setting('fps')} fps`, onClick: () => this.pick('Frame rate', fpsOptions, 'fps') }),
        row({ label: 'Show stream stats', sub: 'Resolution, frame rate, bitrate and latency while playing', toggle: store.setting('stats'), onClick: () => this.toggle('stats') }),
        row({ label: 'Full screen when playing', toggle: store.setting('fullscreen') !== false, onClick: () => store.setSetting('fullscreen', store.setting('fullscreen') === false) }),
      ),
      h('p.note', `Video decoders available in this browser: ${codecs}. The server may lower quality to stay within its limits.`),
    ];
  }

  render_controls() {
    const layouts = [
      { value: 'xbox', label: 'Confirm with the bottom button', desc: 'Most PC and Android controllers' },
      { value: 'nintendo', label: 'Confirm with the right button', desc: 'Console-style A/B layout' },
    ];
    const layout = layouts.find((l) => l.value === store.setting('layout'));
    return [
      h('h2.section-title', 'Menus'),
      h('div.rows', row({ label: 'Button layout', sub: layout?.desc, value: store.setting('layout') === 'nintendo' ? 'Right' : 'Bottom', onClick: () => this.pick('Button layout', layouts, 'layout') })),
      h('h2.section-title', 'In game'),
      h(
        'div.rows',
        row({ label: 'Send keyboard to games', sub: 'Esc always returns to the HOME Menu', toggle: store.setting('keyboardPassthrough'), onClick: () => this.toggle('keyboardPassthrough') }),
        row({ label: 'Left stick acts as D-pad', sub: 'Android key events can’t carry analog sticks', toggle: store.setting('stickAsDpad'), onClick: () => this.toggle('stickAsDpad') }),
        row({ label: 'Test controllers and see mappings', icon: 'controller', onClick: () => router.push(new ControllersScreen()) }),
      ),
    ];
  }

  render_users() {
    const users = store.state.users;
    return [
      h('h2.section-title', 'Users on this browser'),
      h(
        'div.rows',
        users.map((u) =>
          h(
            'button.row',
            { type: 'button', data: { nav: '', navGroup: 'rows', row: u.id }, onclick: () => router.push(new ProfileScreen(u.id)) },
            avatar(u),
            h('span.row-main', h('span', u.name), h('span.row-sub', u.id === store.state.currentUser ? 'Current user' : 'Tap to view profile')),
            svgIcon('chevron', 'lead'),
          ),
        ),
        users.length < 8 &&
          row({
            icon: 'plus',
            label: 'Add user',
            id: 'add-user',
            onClick: async () => {
              const name = await prompt({ title: 'Add user', message: 'Enter a nickname.', placeholder: `Player ${users.length + 1}`, maxLength: 20 });
              if (name) {
                store.addUser(name);
                toast(`${name} was added`, { icon: 'user' });
              }
            },
          }),
      ),
      h('p.note', 'Profiles, play activity and settings are saved in this browser only.'),
    ];
  }

  render_server() {
    const info = app.info;
    const idle = info?.idleTimeout ? `${Math.round(info.idleTimeout / 60)} min without input` : 'Never';
    const max = info?.sessionMaxMinutes ? `${info.sessionMaxMinutes} min` : 'Unlimited';
    return [
      h('h2.section-title', 'Access'),
      h(
        'div.rows',
        row({
          icon: 'lock',
          label: 'Access code',
          sub: info?.accessCodeRequired ? 'This server requires a code to play' : 'Not required by this server',
          value: store.state.accessCode ? 'Saved' : 'Not set',
          onClick: () => this.setAccessCode(),
        }),
        row({
          icon: 'key',
          label: 'Admin token',
          sub: info?.adminEnabled ? 'Lets you install and remove games' : 'Admin features are off on this server',
          value: store.state.adminToken ? 'Saved' : 'Not set',
          onClick: () => this.setAdminToken(),
        }),
      ),
      h('h2.section-title', 'This server'),
      h(
        'div.rows',
        row({ label: 'Name', value: info?.name || '—', id: 's-name' }),
        row({ label: 'Session ends after', value: idle, id: 's-idle' }),
        row({ label: 'Maximum session length', value: max, id: 's-max' }),
        row({ label: 'Highest resolution', value: info ? `${info.limits.maxSize}p` : '—', id: 's-res' }),
      ),
    ];
  }

  render_system() {
    return [
      h('h2.section-title', 'Start-up'),
      h('div.rows', row({ label: 'Show lock screen at start', sub: 'Also unlocks sound playback on first press', toggle: store.setting('lockScreen'), onClick: () => this.toggle('lockScreen') })),
      h('h2.section-title', 'Data'),
      h(
        'div.rows',
        row({
          label: 'Reset all settings and users',
          danger: true,
          onClick: async () => {
            const ok = await confirm({ title: 'Reset everything?', message: 'Settings, users and play activity in this browser will be deleted. Screenshots are kept.', confirmLabel: 'Reset', danger: true });
            if (!ok) return;
            try {
              localStorage.removeItem('synapse:v1');
            } catch {
              /* ignore */
            }
            location.reload();
          },
        }),
      ),
      h('h2.section-title', 'About'),
      h('p.note', 'Synapse streams Android games from a pool of ADB devices using scrcpy, decoded in your browser with WebCodecs. The interface is an original design inspired by console home menus.'),
    ];
  }

  async setAccessCode() {
    const code = await prompt({ title: 'Access code', message: 'Enter the code from the person who runs this server.', value: store.state.accessCode, type: 'password' });
    if (code === null) return;
    store.set('accessCode', code);
    await app.refreshGames();
    if (app.gamesError?.status === 401) alert({ title: 'Wrong code', message: 'The server did not accept that access code.' });
    else toast('Access code saved', { icon: 'lock' });
  }

  async setAdminToken() {
    const token = await prompt({ title: 'Admin token', message: 'Paste the ADMIN_TOKEN configured on the server.', value: store.state.adminToken, type: 'password', maxLength: 200 });
    if (token === null) return;
    store.set('adminToken', token);
    if (!token) return;
    try {
      await api('/api/admin/check', { method: 'POST', admin: true });
      toast('Admin token accepted', { icon: 'key' });
    } catch (err) {
      alert({ title: 'Token not accepted', message: err.message });
    }
  }

  onAction(action) {
    if (action === 'right' && this.nav.contains(this.scope.current)) {
      this.enterContent();
      return true;
    }
    if (action === 'left' && this.content.contains(this.scope.current)) {
      const active = this.nav.querySelector(`[data-cat="${this.category}"]`);
      this.scope.focus(active);
      return true;
    }
    if (action === 'b' && this.content.contains(this.scope.current)) {
      play('back');
      this.scope.focus(this.nav.querySelector(`[data-cat="${this.category}"]`), { sound: false });
      return true;
    }
    return false;
  }
}
