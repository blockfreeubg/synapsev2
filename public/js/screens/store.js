import { h, svgIcon } from '../core/dom.js';
import { Screen } from '../core/router.js';
import { store } from '../core/store.js';
import { api, upload } from '../core/api.js';
import { alert, choose, confirm, prompt } from '../core/dialogs.js';
import { cover, footer, header, spinner, toast } from '../core/ui.js';
import { app } from '../app.js';

const ORANGE = '#f39324';

function summarize(result) {
  const ok = result.results.filter((r) => r.ok).length;
  const failed = result.results.filter((r) => !r.ok);
  return { ok, failed, text: failed.length ? failed.map((f) => `${f.device}: ${f.error}`).join('\n') : '' };
}

export class StoreScreen extends Screen {
  constructor() {
    super('store');
    this.catalog = [];
    this.busy = new Set();
  }

  get isAdmin() {
    return Boolean(app.info?.adminEnabled && store.state.adminToken);
  }

  build() {
    this.body = h('div.page-body', { data: { revealMargin: '40' } });
    this.file = h('input', { type: 'file', accept: '.apk,application/vnd.android.package-archive', hidden: true, onchange: () => this.uploadPicked() });
    this.el.append(header('Game Store', 'shop', { accent: ORANGE }), this.body, this.file, footer([['b', 'Back'], ['a', 'OK']]));
    this.cleanup(app.onChange(() => this.render()));
    this.cleanup(store.subscribe((key) => key === 'adminToken' && this.render()));
    this.load();
  }

  async load() {
    this.body.replaceChildren(h('div.empty-state', spinner(), h('p', 'Loading…')));
    try {
      this.catalog = (await api('/api/catalog')).games;
    } catch (err) {
      this.catalog = [];
      this.loadError = err.message;
    }
    this.render();
  }

  render() {
    const focused = this.scope.current?.dataset.row;
    const admin = this.isAdmin;
    const sections = [
      h(
        'div.store-hero',
        svgIcon('gift'),
        h('div', h('h2', 'Free games, ready to install'), h('p', 'Open-source games from F-Droid. Free to download and legal to run on your own devices.')),
      ),
    ];

    if (!admin) {
      sections.push(
        h(
          'div.rows',
          h(
            'button.row',
            { type: 'button', data: { nav: '', row: 'admin', navDefault: '' }, onclick: () => this.askToken() },
            svgIcon('key', 'lead'),
            h(
              'span.row-main',
              h('span', app.info?.adminEnabled ? 'Enter the admin token to install games' : 'Installing from here is turned off'),
              h('span.row-sub', app.info?.adminEnabled ? 'Ask the person who runs this server.' : 'Set ADMIN_TOKEN on the server to manage games from this page.'),
            ),
          ),
        ),
      );
    }

    sections.push(h('h2.section-title', 'Free & open source'));
    if (this.loadError) sections.push(h('p.note', `Couldn’t load the catalog: ${this.loadError}`));
    sections.push(
      h(
        'div.store-list',
        this.catalog.map((g) => {
          const installed = g.installed || app.games.some((x) => x.package === g.package && x.devices > 0 && !app.demo);
          const busy = this.busy.has(g.package);
          const badge = busy
            ? h('span.badge', spinner(), 'Installing')
            : installed
              ? h('span.badge.ok', svgIcon('check'), 'Installed')
              : admin
                ? h('span.badge.action', svgIcon('download'), 'Install')
                : h('span.badge', 'Free');
          return h(
            'button.store-card',
            { type: 'button', data: { nav: '', row: `cat-${g.package}`, sound: 'none' }, onclick: () => this.installCatalog(g, installed) },
            h('span.thumb', cover(g)),
            h('span', h('h3', g.title), h('p', g.description || g.publisher || g.package)),
            badge,
          );
        }),
      ),
    );

    if (admin) {
      sections.push(
        h('h2.section-title', 'Add your own'),
        h(
          'div.rows',
          h(
            'button.row',
            { type: 'button', data: { nav: '', row: 'upload' }, onclick: () => this.file.click() },
            svgIcon('upload', 'lead'),
            h('span.row-main', h('span', 'Upload an APK'), h('span.row-sub', 'Installs on every online device. Only upload games you have the right to use.')),
          ),
          this.progress && h('div.row', h('span.row-main', h('span', `Uploading ${this.progress.name}…`), h('div.progress', h('i', { style: { width: `${Math.round(this.progress.value * 100)}%` } })))),
        ),
        h('h2.section-title', 'Manage library'),
        app.games.length
          ? h(
              'div.rows',
              app.games.map((g) =>
                h(
                  'button.row.activity',
                  { type: 'button', data: { nav: '', row: `lib-${g.package}` }, onclick: () => this.manage(g) },
                  h('span.thumb', cover(g)),
                  h('span.row-main', h('span', g.title), h('span.row-sub', `${g.package} · ${g.devices} device${g.devices === 1 ? '' : 's'}`)),
                  svgIcon('more', 'lead'),
                ),
              ),
            )
          : h('p.note', 'The library is empty.'),
      );
    }

    this.body.replaceChildren(...sections);
    const again = focused && this.body.querySelector(`[data-row="${CSS.escape(focused)}"]`);
    if (again) this.scope.focus(again, { sound: false, scroll: false });
    else if (this.el.isConnected) this.scope.focusInitial({ smooth: false });
  }

  async askToken() {
    if (!app.info?.adminEnabled) {
      return alert({ title: 'Admin features are off', message: 'Start the server with ADMIN_TOKEN set to install and manage games from here.', sound: null });
    }
    const token = await prompt({ title: 'Admin token', message: 'Paste the ADMIN_TOKEN configured on the server.', type: 'password', maxLength: 200 });
    if (!token) return;
    store.set('adminToken', token);
    try {
      await api('/api/admin/check', { method: 'POST', admin: true });
      toast('Admin token accepted', { icon: 'key' });
    } catch (err) {
      store.set('adminToken', '');
      alert({ title: 'Token not accepted', message: err.message });
    }
  }

  async installCatalog(game, installed) {
    if (installed) return toast(`${game.title} is already installed`, { icon: 'check', sound: null });
    if (!this.isAdmin) return this.askToken();
    if (this.busy.has(game.package)) return;
    const ok = await confirm({ title: `Install ${game.title}?`, message: 'The server downloads it from F-Droid and installs it on every online device. This can take a few minutes.', confirmLabel: 'Install' });
    if (!ok) return;
    this.busy.add(game.package);
    this.render();
    try {
      const result = await api(`/api/admin/fdroid/${encodeURIComponent(game.package)}`, { method: 'POST', admin: true });
      const s = summarize(result);
      if (s.ok) toast(`${game.title} ${result.version} installed on ${s.ok} device${s.ok === 1 ? '' : 's'}`, { icon: 'check' });
      if (s.failed.length) alert({ title: s.ok ? 'Installed on some devices' : 'Install failed', message: s.text });
    } catch (err) {
      alert({ title: 'Install failed', message: err.message });
    } finally {
      this.busy.delete(game.package);
      await app.refreshGames();
      this.catalog = (await api('/api/catalog').catch(() => ({ games: this.catalog }))).games;
      this.render();
    }
  }

  async uploadPicked() {
    const file = this.file.files[0];
    this.file.value = '';
    if (!file) return;
    const title = await prompt({ title: 'Game title', message: 'Shown on the HOME Menu. Leave empty to use the package name.', value: file.name.replace(/\.apk$/i, ''), maxLength: 60 });
    if (title === null) return;
    this.progress = { name: file.name, value: 0 };
    this.render();
    try {
      const result = await upload(`/api/admin/apps?title=${encodeURIComponent(title)}`, file, {
        onProgress: (v) => {
          this.progress.value = v;
          const bar = this.body.querySelector('.progress i');
          if (bar) bar.style.width = `${Math.round(v * 100)}%`;
        },
      });
      const s = summarize(result);
      if (s.ok) toast(`Installed on ${s.ok} device${s.ok === 1 ? '' : 's'}`, { icon: 'check' });
      if (s.failed.length) alert({ title: s.ok ? 'Installed on some devices' : 'Install failed', message: s.text });
      if (s.ok && !result.package) alert({ title: 'Installed', message: 'The app was updated in place. It keeps its existing library entry.', sound: null });
    } catch (err) {
      alert({ title: 'Upload failed', message: err.message });
    } finally {
      this.progress = null;
      await app.refreshGames();
    }
  }

  async manage(game) {
    const action = await choose({
      title: game.title,
      options: [
        { value: 'rename', label: 'Rename' },
        { value: 'cover', label: 'Set cover image', desc: 'Square PNG, JPEG or WebP' },
        { value: 'hide', label: 'Hide from the HOME Menu', desc: 'Keeps it installed' },
        { value: 'uninstall', label: 'Uninstall from all devices' },
      ],
    });
    try {
      if (action === 'rename') {
        const title = await prompt({ title: 'Rename', value: game.title, maxLength: 60 });
        if (title) await api(`/api/admin/apps/${encodeURIComponent(game.package)}`, { method: 'PATCH', admin: true, body: { title } });
      } else if (action === 'cover') {
        const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
        picker.onchange = async () => {
          const file = picker.files[0];
          if (!file) return;
          try {
            await api(`/api/admin/apps/${encodeURIComponent(game.package)}/cover`, { method: 'PUT', admin: true, body: file, contentType: file.type });
            toast('Cover updated', { icon: 'album' });
            app.refreshGames();
          } catch (err) {
            alert({ title: 'Couldn’t set cover', message: err.message });
          }
        };
        picker.click();
      } else if (action === 'hide') {
        await api(`/api/admin/apps/${encodeURIComponent(game.package)}`, { method: 'PATCH', admin: true, body: { hidden: true } });
        toast(`${game.title} hidden`, { icon: 'hide', sound: null });
      } else if (action === 'uninstall') {
        const ok = await confirm({ title: `Uninstall ${game.title}?`, message: 'It will be removed from every device, including saved data.', confirmLabel: 'Uninstall', danger: true });
        if (!ok) return;
        await api(`/api/admin/apps/${encodeURIComponent(game.package)}`, { method: 'DELETE', admin: true });
        toast(`${game.title} uninstalled`, { icon: 'trash', sound: null });
      }
    } catch (err) {
      alert({ title: 'Something went wrong', message: err.message });
    }
    app.refreshGames();
  }
}
