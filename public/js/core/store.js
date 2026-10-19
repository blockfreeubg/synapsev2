// Per-browser preferences, profiles and play history in localStorage.
// Every access is guarded: storage can be unavailable (private mode, blocked).

const KEY = 'synapse:v1';
const COLORS = ['#ff5a5f', '#2b9af3', '#19b98a', '#f5a623', '#9b59f6', '#ff7ab6', '#00b8d4', '#7cb342'];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function newUser(name, index = 0) {
  return { id: uid(), name, color: COLORS[index % COLORS.length], created: Date.now() };
}

export const USER_COLORS = COLORS;

const defaults = () => {
  const first = newUser('Player 1');
  return {
    settings: {
      theme: 'light', // light | dark | system
      sounds: true,
      volume: 0.7,
      quality: 'balanced',
      fps: 60,
      audio: true,
      stats: false,
      keyboardPassthrough: true,
      stickAsDpad: true,
      layout: 'xbox', // xbox: confirm = bottom face button; nintendo: confirm = right face button
      lockScreen: true,
      fullscreen: true,
    },
    users: [first],
    currentUser: first.id,
    history: {},
    adminToken: '',
    accessCode: '',
  };
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const base = defaults();
      return { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
    }
  } catch {
    /* fall through to defaults */
  }
  return defaults();
}

const listeners = new Set();
let state = load();
if (!state.users.length) state = { ...state, ...defaults() };

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

export const store = {
  get state() {
    return state;
  },
  setting(name) {
    return state.settings[name];
  },
  setSetting(name, value) {
    state.settings = { ...state.settings, [name]: value };
    persist();
    listeners.forEach((fn) => fn('settings', name));
  },
  set(key, value) {
    state = { ...state, [key]: value };
    persist();
    listeners.forEach((fn) => fn(key));
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  get user() {
    return state.users.find((u) => u.id === state.currentUser) || state.users[0];
  },
  addUser(name) {
    const user = newUser(name, state.users.length);
    store.set('users', [...state.users, user]);
    return user;
  },
  updateUser(id, fields) {
    store.set('users', state.users.map((u) => (u.id === id ? { ...u, ...fields } : u)));
  },
  removeUser(id) {
    if (state.users.length <= 1) return;
    const users = state.users.filter((u) => u.id !== id);
    const history = { ...state.history };
    delete history[id];
    state = { ...state, users, history, currentUser: state.currentUser === id ? users[0].id : state.currentUser };
    persist();
    listeners.forEach((fn) => fn('users'));
  },

  historyFor(userId = state.currentUser) {
    return state.history[userId] || {};
  },
  recordPlay(pkg, seconds, userId = state.currentUser) {
    const mine = { ...store.historyFor(userId) };
    const prev = mine[pkg] || { totalSeconds: 0, sessions: 0 };
    mine[pkg] = {
      totalSeconds: prev.totalSeconds + Math.max(0, seconds),
      sessions: prev.sessions + (seconds > 0 ? 1 : 0),
      lastPlayed: Date.now(),
    };
    store.set('history', { ...state.history, [userId]: mine });
  },
};
