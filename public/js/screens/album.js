import { h, svgIcon, timeAgo } from '../core/dom.js';
import { Dialog, Screen } from '../core/router.js';
import { play } from '../core/sound.js';
import { confirm } from '../core/dialogs.js';
import { footer, glyphWithKey, header, toast } from '../core/ui.js';
import { deleteShot, listShots } from '../core/album.js';

function download(shot) {
  const a = h('a', { href: URL.createObjectURL(shot.blob), download: `${shot.title.replace(/[^\w-]+/g, '_')}-${shot.id}.png` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export class AlbumScreen extends Screen {
  constructor() {
    super('album');
    this.urls = [];
  }

  build() {
    this.body = h('div.page-body', { data: { revealMargin: '40' } });
    this.el.append(header('Album', 'album', { accent: '#2c96ee' }), this.body, footer([['x', 'Delete'], ['b', 'Back'], ['a', 'View']]));
    this.cleanup(() => this.urls.forEach((u) => URL.revokeObjectURL(u)));
    this.load();
  }

  async load() {
    this.shots = await listShots();
    this.render();
  }

  render() {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    if (!this.shots.length) {
      this.body.replaceChildren(h('div.empty-state', svgIcon('camera'), h('p', 'No screenshots yet.'), h('p.note', 'While playing, press F8 or use Capture Screenshot in the quick menu.')));
      return;
    }
    this.body.replaceChildren(
      h(
        'div.grid.album-grid',
        this.shots.map((shot, i) => {
          const url = URL.createObjectURL(shot.blob);
          this.urls.push(url);
          return h(
            'button.grid-item',
            { type: 'button', data: { nav: '', index: i }, onclick: () => this.view(i) },
            h('span.thumb', h('img', { src: url, alt: '' })),
            h('span.caption', shot.title, h('small', timeAgo(shot.ts))),
          );
        }),
      ),
    );
    this.scope.focusInitial({ smooth: false });
  }

  async remove(index) {
    const shot = this.shots[index];
    if (!shot) return;
    const ok = await confirm({ title: 'Delete this screenshot?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await deleteShot(shot.id);
    this.shots.splice(index, 1);
    this.scope.current = null;
    this.render();
    toast('Screenshot deleted', { icon: 'trash', sound: null });
  }

  async view(index) {
    const viewer = new Viewer(this, index);
    await viewer.open();
  }

  onAction(action) {
    if (action === 'x' && this.scope.current?.dataset.index !== undefined) {
      this.remove(Number(this.scope.current.dataset.index));
      return true;
    }
    return false;
  }
}

class Viewer extends Dialog {
  constructor(album, index) {
    super('viewer');
    this.album = album;
    this.index = index;
    this.img = h('img', { alt: '' });
    this.caption = h('span');
    this.el.append(
      this.img,
      h(
        'div.viewer-bar',
        this.caption,
        h(
          'div.hints',
          h('button.hint', { type: 'button', data: { nav: '' }, onclick: () => download(this.shot) }, glyphWithKey('y'), h('span', 'Save')),
          h('button.hint', { type: 'button', data: { nav: '' }, onclick: () => this.close() }, glyphWithKey('b'), h('span', 'Close')),
        ),
      ),
    );
    this.show();
  }

  get shot() {
    return this.album.shots[this.index];
  }

  show() {
    const url = URL.createObjectURL(this.shot.blob);
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = url;
    this.img.src = url;
    this.caption.textContent = `${this.shot.title} · ${new Date(this.shot.ts).toLocaleString()} · ${this.index + 1}/${this.album.shots.length}`;
  }

  close(v) {
    if (this.url) URL.revokeObjectURL(this.url);
    super.close(v);
  }

  onAction(action) {
    if (action === 'left' || action === 'right') {
      const next = this.index + (action === 'left' ? -1 : 1);
      if (next < 0 || next >= this.album.shots.length) play('bump');
      else {
        this.index = next;
        play('move');
        this.show();
      }
      return true;
    }
    if (action === 'y') {
      download(this.shot);
      return true;
    }
    if (action === 'a') return true;
    return false;
  }
}
