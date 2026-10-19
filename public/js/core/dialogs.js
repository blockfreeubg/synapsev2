import { h, svgIcon } from './dom.js';
import { Dialog } from './router.js';
import { avatar } from './ui.js';
import { play } from './sound.js';

function buttonRow(buttons, onPick) {
  return h(
    'div.dialog-buttons',
    buttons.map((b, i) =>
      h(
        'button.dialog-button',
        {
          type: 'button',
          class: b.danger ? 'danger' : '',
          data: { nav: '', ...(b.default || (i === buttons.length - 1 && !buttons.some((x) => x.default)) ? { navDefault: '' } : {}) },
          onclick: () => onPick(b.value),
        },
        b.label,
      ),
    ),
  );
}

export function confirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  const d = new Dialog();
  d.el.append(
    h(
      'div.dialog',
      { role: 'dialog', 'aria-modal': 'true' },
      h('div.dialog-body', title && h('h2', title), message && h('p', message)),
      buttonRow(
        [
          { label: cancelLabel, value: false },
          { label: confirmLabel, value: true, danger, default: true },
        ],
        (v) => d.close(v),
      ),
    ),
  );
  d.back = () => {
    play('back');
    d.close(false);
  };
  return d.open();
}

export function alert({ title, message, okLabel = 'OK', sound = 'error' }) {
  if (sound) play(sound);
  const d = new Dialog();
  d.el.append(
    h(
      'div.dialog',
      { role: 'alertdialog', 'aria-modal': 'true' },
      h('div.dialog-body', title && h('h2', title), message && h('p', message)),
      buttonRow([{ label: okLabel, value: true }], (v) => d.close(v)),
    ),
  );
  return d.open();
}

/** Pick one option from a list. Resolves with the value, or null. */
export function choose({ title, options, value }) {
  const d = new Dialog();
  d.el.append(
    h(
      'div.dialog.dialog-list',
      { role: 'dialog', 'aria-modal': 'true' },
      title && h('h2.dialog-title', title),
      h(
        'div.choice-list',
        options.map((o) =>
          h(
            'button.choice',
            {
              type: 'button',
              class: o.value === value ? 'selected' : '',
              data: { nav: '', ...(o.value === value ? { navDefault: '' } : {}) },
              onclick: () => d.close(o.value),
            },
            h('span.choice-radio'),
            h('span.choice-text', h('span.choice-label', o.label), o.desc && h('span.choice-desc', o.desc)),
          ),
        ),
      ),
    ),
  );
  return d.open();
}

/** Ask for text. Resolves with the trimmed string, or null when cancelled. */
export function prompt({ title, message, value = '', placeholder = '', type = 'text', maxLength = 64, okLabel = 'OK' }) {
  const d = new Dialog();
  const field = h('input.text-field', { type, value, placeholder, maxLength, autocomplete: 'off', spellcheck: false, data: { nav: '', navDefault: '' } });
  const submit = () => d.close(field.value.trim());
  d.el.append(
    h(
      'div.dialog',
      { role: 'dialog', 'aria-modal': 'true' },
      h('div.dialog-body', title && h('h2', title), message && h('p', message), field),
      buttonRow(
        [
          { label: 'Cancel', value: null },
          { label: okLabel, value: 'ok' },
        ],
        (v) => (v === 'ok' ? submit() : d.close(null)),
      ),
    ),
  );
  d.onAction = (action) => {
    if (action === 'a' && d.scope.current === field) {
      play('select');
      submit();
      return true;
    }
    return false;
  };
  const opened = d.open();
  setTimeout(() => field.select(), 50);
  return opened;
}

/** Console-style "Select a user" picker. */
export function pickUser(users, currentId) {
  const d = new Dialog('user-picker');
  d.el.append(
    h(
      'div.user-picker-panel',
      h('h2', 'Select a user'),
      h(
        'div.user-picker-row',
        users.map((u) =>
          h(
            'button.user-pick',
            { type: 'button', data: { nav: '', ...(u.id === currentId ? { navDefault: '' } : {}) }, onclick: () => d.close(u.id) },
            avatar(u, 'xl'),
            h('span.user-pick-name', u.name),
          ),
        ),
      ),
      h('button.user-picker-cancel', { type: 'button', data: { nav: '' }, onclick: () => d.close(null) }, svgIcon('close'), 'Cancel'),
    ),
  );
  return d.open();
}
