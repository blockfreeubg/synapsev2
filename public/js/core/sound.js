// Interface sounds synthesised with Web Audio (no audio files).
import { store } from './store.js';

let ctx = null;
let master = null;
let noiseBuffer = null;

export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return ctx;
}

/** Call from a user gesture so later sounds (and game audio) may play. */
export function unlockAudio() {
  const c = audioContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

function noise() {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

function ready() {
  if (!store.setting('sounds')) return false;
  const c = audioContext();
  if (!c || c.state !== 'running') return false;
  master.gain.value = store.setting('volume') ?? 0.7;
  return true;
}

function tone({ freq, to = freq, type = 'sine', at = 0, dur = 0.08, gain = 0.2, attack = 0.004 }) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function burst({ at = 0, dur = 0.01, freq = 3000, q = 1.2, gain = 0.3, type = 'bandpass' }) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noise();
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

const sounds = {
  // Short wooden tick for moving the cursor.
  move() {
    tone({ freq: 1750, to: 1150, type: 'triangle', dur: 0.035, gain: 0.12 });
    burst({ dur: 0.006, freq: 4200, gain: 0.08 });
  },
  select() {
    tone({ freq: 880, to: 1000, dur: 0.06, gain: 0.16 });
    tone({ freq: 1320, to: 1480, dur: 0.08, gain: 0.14, at: 0.045 });
  },
  back() {
    tone({ freq: 760, to: 620, dur: 0.06, gain: 0.14 });
    tone({ freq: 520, to: 430, dur: 0.08, gain: 0.12, at: 0.045 });
  },
  bump() {
    tone({ freq: 200, to: 120, dur: 0.07, gain: 0.22 });
  },
  toggle() {
    tone({ freq: 1250, dur: 0.04, gain: 0.12, type: 'triangle' });
    burst({ dur: 0.005, freq: 5000, gain: 0.06 });
  },
  launch() {
    tone({ freq: 420, to: 1260, dur: 0.32, gain: 0.12 });
    tone({ freq: 630, to: 1890, dur: 0.32, gain: 0.06, at: 0.03 });
    burst({ dur: 0.35, freq: 1800, q: 0.6, gain: 0.05, type: 'highpass' });
  },
  // Two crisp clicks, like a controller snapping into place.
  snap() {
    burst({ dur: 0.012, freq: 2600, q: 3, gain: 0.5 });
    tone({ freq: 2100, to: 1500, dur: 0.02, gain: 0.12, type: 'square' });
    burst({ at: 0.09, dur: 0.014, freq: 3400, q: 3, gain: 0.55 });
    tone({ freq: 2500, to: 1700, dur: 0.025, gain: 0.12, type: 'square', at: 0.09 });
  },
  notify() {
    tone({ freq: 988, dur: 0.12, gain: 0.12 });
    tone({ freq: 1319, dur: 0.18, gain: 0.12, at: 0.09 });
  },
  error() {
    tone({ freq: 240, dur: 0.09, gain: 0.12, type: 'square' });
    tone({ freq: 200, dur: 0.12, gain: 0.12, type: 'square', at: 0.11 });
  },
  capture() {
    burst({ dur: 0.05, freq: 1500, q: 0.8, gain: 0.4 });
    burst({ at: 0.07, dur: 0.04, freq: 2500, q: 0.8, gain: 0.3 });
  },
  home() {
    tone({ freq: 1046, dur: 0.1, gain: 0.12 });
    tone({ freq: 784, dur: 0.16, gain: 0.1, at: 0.06 });
  },
};

export function play(name) {
  if (!ready()) return;
  try {
    sounds[name]?.();
  } catch {
    /* ignore audio errors */
  }
}
