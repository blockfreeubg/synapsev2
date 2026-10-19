// Shared application state.

import { api } from './core/api.js';
import { store } from './core/store.js';
import { setServerOnline } from './core/ui.js';

const listeners = new Set();

export const app = {
  info: null,
  games: [],
  demo: false,
  codecs: [],
  opus: false,
  /** The PlayerScreen of the game that is running or suspended, if any. */
  running: null,
  gamesError: null,

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  changed() {
    listeners.forEach((fn) => fn());
  },

  async refreshGames() {
    try {
      const data = await api('/api/games');
      this.games = data.games;
      this.demo = data.demo;
      this.gamesError = null;
      setServerOnline(true);
    } catch (err) {
      this.gamesError = err;
      if (err.status !== 401) setServerOnline(false);
    }
    this.changed();
    return this.games;
  },

  game(pkg) {
    return this.games.find((g) => g.package === pkg) || null;
  },

  /** Games ordered like a console home menu: most recently played first. */
  recentGames() {
    const history = store.historyFor();
    return [...this.games].sort((a, b) => {
      const la = history[a.package]?.lastPlayed || 0;
      const lb = history[b.package]?.lastPlayed || 0;
      return lb - la || a.title.localeCompare(b.title);
    });
  },
};
