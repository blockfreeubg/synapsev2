// scrcpy 3.x wire protocol: the media stream framing coming off the device and
// the control messages going to it. Reference: scrcpy doc/develop.md and
// app/src/control_msg.c in https://github.com/Genymobile/scrcpy.

import { EventEmitter } from 'node:events';

const CODECS = new Map([
  [0x68323634, 'h264'], // "h264"
  [0x68323635, 'h265'], // "h265"
  [0x00617631, 'av1'], //  "\0av1"
  [0x6f707573, 'opus'], // "opus"
  [0x00616163, 'aac'], //  "\0aac"
  [0x666c6163, 'flac'], // "flac"
  [0x00726177, 'raw'], //  "\0raw"
]);

const CODEC_IDS = new Map([...CODECS].map(([id, name]) => [name, id]));

export function codecId(name) {
  return CODEC_IDS.get(name);
}

const FLAG_CONFIG = 1n << 63n;
const FLAG_KEY = 1n << 62n;
const PTS_MASK = FLAG_KEY - 1n;
const DEVICE_NAME_LENGTH = 64;
const MAX_PACKET = 32 * 1024 * 1024;

// Append-only byte buffer that hands out exact-length reads without copying
// when a read falls inside a single chunk.
export class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(buf) {
    if (buf.length) {
      this.chunks.push(buf);
      this.length += buf.length;
    }
  }

  read(n) {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length >= n) {
      this.length -= n;
      if (first.length === n) {
        this.chunks.shift();
        return first;
      }
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.length -= n;
    return out;
  }
}

/**
 * Parses one scrcpy media socket.
 *
 * Events:
 *   device  (name)                     only when deviceMeta is true
 *   meta    ({ codec, width, height }) width/height only for video
 *   disabled({ reason })               the device could not provide this stream
 *   packet  ({ config, key, pts, data })
 *   error   (Error)
 */
export class MediaStreamParser extends EventEmitter {
  constructor({ kind, deviceMeta = false }) {
    super();
    this.kind = kind;
    this.queue = new ByteQueue();
    this.state = deviceMeta ? 'device' : 'codec';
    this.header = null;
  }

  feed(buf) {
    this.queue.push(buf);
    try {
      while (this.step());
    } catch (err) {
      this.state = 'dead';
      this.emit('error', err);
    }
  }

  step() {
    const q = this.queue;
    switch (this.state) {
      case 'device': {
        if (q.length < DEVICE_NAME_LENGTH) return false;
        const raw = q.read(DEVICE_NAME_LENGTH);
        const end = raw.indexOf(0);
        this.emit('device', raw.subarray(0, end === -1 ? raw.length : end).toString('utf8'));
        this.state = 'codec';
        return true;
      }
      case 'codec': {
        if (q.length < 4) return false;
        const id = q.read(4).readUInt32BE(0);
        if (id === 0 || id === 1) {
          this.state = 'dead';
          this.emit('disabled', { reason: id === 0 ? 'disabled' : 'error' });
          return false;
        }
        const codec = CODECS.get(id);
        if (!codec) throw new Error(`Unknown ${this.kind} codec id 0x${id.toString(16)}`);
        this.codec = codec;
        if (this.kind === 'video') {
          this.state = 'size';
        } else {
          this.emit('meta', { codec });
          this.state = 'header';
        }
        return true;
      }
      case 'size': {
        if (q.length < 8) return false;
        const size = q.read(8);
        this.emit('meta', {
          codec: this.codec,
          width: size.readUInt32BE(0),
          height: size.readUInt32BE(4),
        });
        this.state = 'header';
        return true;
      }
      case 'header': {
        if (q.length < 12) return false;
        const h = q.read(12);
        const ptsAndFlags = h.readBigUInt64BE(0);
        const size = h.readUInt32BE(8);
        if (size > MAX_PACKET) throw new Error(`Packet too large (${size} bytes)`);
        this.header = {
          config: (ptsAndFlags & FLAG_CONFIG) !== 0n,
          key: (ptsAndFlags & FLAG_KEY) !== 0n,
          pts: ptsAndFlags & PTS_MASK,
          size,
        };
        this.state = 'body';
        return true;
      }
      case 'body': {
        const { size, ...rest } = this.header;
        if (q.length < size) return false;
        this.emit('packet', { ...rest, data: q.read(size) });
        this.header = null;
        this.state = 'header';
        return true;
      }
      default:
        // 'dead': discard anything else that arrives.
        q.read(q.length);
        return false;
    }
  }
}

/** Frame a media packet for the browser: [kind u8][flags u8][pts u64 BE][payload]. */
export const PacketKind = { VIDEO: 1, AUDIO: 2 };

export function framePacket(kind, { config, key, pts, data }) {
  const out = Buffer.allocUnsafe(10 + data.length);
  out[0] = kind;
  out[1] = (config ? 1 : 0) | (key ? 2 : 0);
  out.writeBigUInt64BE(BigInt(pts), 2);
  data.copy(out, 10);
  return out;
}

// ---------------------------------------------------------------------------
// Control messages (client -> device)

export const ControlType = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  ROTATE_DEVICE: 11,
};

export const MotionAction = { DOWN: 0, UP: 1, MOVE: 2 };
export const KeyAction = { DOWN: 0, UP: 1 };
export const TEXT_MAX_BYTES = 300;

function u16fp(f) {
  const u = Math.floor(f * 0x10000);
  return Math.max(0, Math.min(0xffff, u));
}

function i16fp(f) {
  const i = Math.trunc(Math.max(-1, Math.min(1, f)) * 0x8000);
  return Math.max(-0x8000, Math.min(0x7fff, i));
}

function writePosition(buf, offset, { x, y, width, height }) {
  buf.writeInt32BE(x, offset);
  buf.writeInt32BE(y, offset + 4);
  buf.writeUInt16BE(width, offset + 8);
  buf.writeUInt16BE(height, offset + 10);
}

export function serializeKeycode({ action, keycode, repeat = 0, metaState = 0 }) {
  const buf = Buffer.alloc(14);
  buf[0] = ControlType.INJECT_KEYCODE;
  buf[1] = action;
  buf.writeUInt32BE(keycode, 2);
  buf.writeUInt32BE(repeat, 6);
  buf.writeUInt32BE(metaState, 10);
  return buf;
}

export function serializeText(text) {
  let bytes = Buffer.from(text, 'utf8');
  if (bytes.length > TEXT_MAX_BYTES) {
    // Trim on a character boundary so we never send half a code point.
    bytes = Buffer.from(bytes.subarray(0, TEXT_MAX_BYTES).toString('utf8').replace(/�+$/, ''));
  }
  const buf = Buffer.alloc(5 + bytes.length);
  buf[0] = ControlType.INJECT_TEXT;
  buf.writeUInt32BE(bytes.length, 1);
  bytes.copy(buf, 5);
  return buf;
}

export function serializeTouch({ action, pointerId, position, pressure, actionButton = 0, buttons = 0 }) {
  const buf = Buffer.alloc(32);
  buf[0] = ControlType.INJECT_TOUCH_EVENT;
  buf[1] = action;
  buf.writeBigUInt64BE(BigInt.asUintN(64, BigInt(pointerId)), 2);
  writePosition(buf, 10, position);
  buf.writeUInt16BE(u16fp(pressure), 22);
  buf.writeUInt32BE(actionButton, 24);
  buf.writeUInt32BE(buttons, 28);
  return buf;
}

export function serializeScroll({ position, hscroll, vscroll, buttons = 0 }) {
  const buf = Buffer.alloc(21);
  buf[0] = ControlType.INJECT_SCROLL_EVENT;
  writePosition(buf, 1, position);
  // scrcpy normalises scroll amounts to [-16, 16] then maps them to [-1, 1].
  buf.writeInt16BE(i16fp(hscroll / 16), 13);
  buf.writeInt16BE(i16fp(vscroll / 16), 15);
  buf.writeUInt32BE(buttons, 17);
  return buf;
}

export function serializeRotate() {
  return Buffer.from([ControlType.ROTATE_DEVICE]);
}

// Android keycodes a player may send. Excludes keys that leave the game or
// touch device state (HOME, POWER, RECENTS, EXPLORER, ENVELOPE, ASSIST, ...).
const ALLOWED_KEYCODES = new Set([
  4, // BACK
  ...range(7, 16), // 0-9
  ...range(19, 25), // DPAD, DPAD_CENTER, VOLUME_UP/DOWN
  ...range(29, 62), // A-Z, punctuation, ALT, SHIFT, TAB, SPACE
  ...range(66, 77), // ENTER .. AT
  81, // PLUS
  82, // MENU
  92, 93, // PAGE_UP/DOWN
  ...range(96, 110), // gamepad buttons
  ...range(111, 115), // ESCAPE, FORWARD_DEL, CTRL, CAPS_LOCK
  ...range(122, 124), // MOVE_HOME, MOVE_END, INSERT
  ...range(131, 142), // F1-F12
  164, // VOLUME_MUTE
]);
const SYSTEM_KEYCODES = new Set([3, 187]); // HOME, APP_SWITCH

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function isInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function isNum(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function position(msg) {
  const { x, y, w, h } = msg;
  if (!isInt(w, 1, 0xffff) || !isInt(h, 1, 0xffff)) return null;
  if (!isNum(x, 0, w) || !isNum(y, 0, h)) return null;
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

/**
 * Turn a JSON message from the browser into a scrcpy control message.
 * Returns null for anything malformed or not allowed.
 */
export function controlFromClient(msg, { allowSystemKeys = false } = {}) {
  if (!msg || typeof msg !== 'object') return null;
  switch (msg.t) {
    case 'touch': {
      const pos = position(msg);
      if (!pos || !isInt(msg.a, 0, 2) || !isInt(msg.id, -2, 31)) return null;
      const pressure = msg.a === MotionAction.UP ? 0 : isNum(msg.p, 0, 1) ? msg.p : 1;
      return serializeTouch({ action: msg.a, pointerId: msg.id, position: pos, pressure });
    }
    case 'key': {
      if (!isInt(msg.a, 0, 1) || !Number.isInteger(msg.k)) return null;
      const allowed = ALLOWED_KEYCODES.has(msg.k) || (allowSystemKeys && SYSTEM_KEYCODES.has(msg.k));
      if (!allowed) return null;
      return serializeKeycode({
        action: msg.a,
        keycode: msg.k,
        repeat: isInt(msg.r, 0, 1000) ? msg.r : 0,
        metaState: isInt(msg.m, 0, 0xffff) ? msg.m : 0,
      });
    }
    case 'scroll': {
      const pos = position(msg);
      if (!pos || !isNum(msg.hs ?? 0, -16, 16) || !isNum(msg.vs ?? 0, -16, 16)) return null;
      return serializeScroll({ position: pos, hscroll: msg.hs ?? 0, vscroll: msg.vs ?? 0 });
    }
    case 'text':
      if (typeof msg.s !== 'string' || !msg.s.length) return null;
      return serializeText(msg.s);
    case 'rotate':
      return serializeRotate();
    default:
      return null;
  }
}
