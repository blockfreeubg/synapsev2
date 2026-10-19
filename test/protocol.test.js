import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteQueue,
  MediaStreamParser,
  controlFromClient,
  framePacket,
  serializeKeycode,
  serializeScroll,
  serializeText,
  serializeTouch,
  PacketKind,
  codecId,
} from '../server/protocol.js';

function header(pts, size, { config = false, key = false } = {}) {
  const buf = Buffer.alloc(12);
  let v = BigInt(pts);
  if (config) v |= 1n << 63n;
  if (key) v |= 1n << 62n;
  buf.writeBigUInt64BE(v, 0);
  buf.writeUInt32BE(size, 8);
  return buf;
}

function videoStream() {
  const name = Buffer.alloc(64);
  name.write('Pixel Test');
  const codec = Buffer.alloc(12);
  codec.writeUInt32BE(codecId('h264'), 0);
  codec.writeUInt32BE(1280, 4);
  codec.writeUInt32BE(720, 8);
  const cfg = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f]);
  const frame = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5]);
  return Buffer.concat([name, codec, header(0, cfg.length, { config: true }), cfg, header(16666, frame.length, { key: true }), frame]);
}

test('ByteQueue reads across chunk boundaries', () => {
  const q = new ByteQueue();
  q.push(Buffer.from([1, 2]));
  q.push(Buffer.from([3, 4, 5]));
  assert.deepEqual([...q.read(1)], [1]);
  assert.deepEqual([...q.read(3)], [2, 3, 4]);
  assert.equal(q.length, 1);
  assert.deepEqual([...q.read(1)], [5]);
});

test('MediaStreamParser parses device meta, codec meta and packets byte by byte', () => {
  const parser = new MediaStreamParser({ kind: 'video', deviceMeta: true });
  const events = [];
  parser.on('device', (n) => events.push(['device', n]));
  parser.on('meta', (m) => events.push(['meta', m]));
  parser.on('packet', (p) => events.push(['packet', { ...p, data: [...p.data] }]));
  const stream = videoStream();
  for (const byte of stream) parser.feed(Buffer.from([byte]));
  assert.deepEqual(events[0], ['device', 'Pixel Test']);
  assert.deepEqual(events[1], ['meta', { codec: 'h264', width: 1280, height: 720 }]);
  assert.equal(events[2][1].config, true);
  assert.equal(events[3][1].key, true);
  assert.equal(events[3][1].pts, 16666n);
  assert.deepEqual(events[3][1].data, [0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5]);
});

test('MediaStreamParser reports a disabled audio stream', () => {
  const parser = new MediaStreamParser({ kind: 'audio' });
  let disabled = null;
  parser.on('disabled', (d) => (disabled = d));
  parser.feed(Buffer.from([0, 0, 0, 0]));
  assert.deepEqual(disabled, { reason: 'disabled' });
});

test('touch events serialise to the 32-byte scrcpy layout', () => {
  const buf = serializeTouch({ action: 0, pointerId: -2, position: { x: 100, y: 200, width: 1280, height: 720 }, pressure: 1 });
  assert.equal(buf.length, 32);
  assert.equal(buf[0], 2);
  assert.equal(buf[1], 0);
  assert.equal(buf.readBigUInt64BE(2), 0xfffffffffffffffen);
  assert.equal(buf.readInt32BE(10), 100);
  assert.equal(buf.readInt32BE(14), 200);
  assert.equal(buf.readUInt16BE(18), 1280);
  assert.equal(buf.readUInt16BE(20), 720);
  assert.equal(buf.readUInt16BE(22), 0xffff);
  assert.equal(buf.readUInt32BE(24), 0);
  assert.equal(buf.readUInt32BE(28), 0);
});

test('keycode, scroll and text messages have the expected sizes', () => {
  const key = serializeKeycode({ action: 1, keycode: 96, repeat: 2, metaState: 0x41 });
  assert.equal(key.length, 14);
  assert.deepEqual([key[0], key[1], key.readUInt32BE(2), key.readUInt32BE(6), key.readUInt32BE(10)], [0, 1, 96, 2, 0x41]);

  const scroll = serializeScroll({ position: { x: 1, y: 2, width: 10, height: 10 }, hscroll: 0, vscroll: 16 });
  assert.equal(scroll.length, 21);
  assert.equal(scroll.readInt16BE(15), 0x7fff);

  const text = serializeText('héllo');
  assert.equal(text[0], 1);
  assert.equal(text.readUInt32BE(1), Buffer.byteLength('héllo'));
  assert.equal(serializeText('é'.repeat(400)).readUInt32BE(1), 300);
});

test('controlFromClient validates and filters input', () => {
  assert.ok(controlFromClient({ t: 'touch', a: 0, id: 1, x: 10, y: 10, w: 100, h: 100 }));
  assert.equal(controlFromClient({ t: 'touch', a: 0, id: 1, x: 500, y: 10, w: 100, h: 100 }), null, 'outside the screen');
  assert.equal(controlFromClient({ t: 'touch', a: 9, id: 1, x: 1, y: 1, w: 100, h: 100 }), null, 'bad action');
  assert.ok(controlFromClient({ t: 'key', a: 0, k: 96 }), 'gamepad A');
  assert.ok(controlFromClient({ t: 'key', a: 0, k: 4 }), 'BACK');
  assert.equal(controlFromClient({ t: 'key', a: 0, k: 3 }), null, 'HOME blocked by default');
  assert.equal(controlFromClient({ t: 'key', a: 0, k: 26 }), null, 'POWER always blocked');
  assert.equal(controlFromClient({ t: 'key', a: 0, k: 64 }), null, 'EXPLORER blocked');
  assert.ok(controlFromClient({ t: 'key', a: 0, k: 3 }, { allowSystemKeys: true }), 'HOME when allowed');
  assert.equal(controlFromClient({ t: 'clipboard', s: 'x' }), null, 'unknown type');
  assert.equal(controlFromClient(null), null);
});

test('framePacket prefixes kind, flags and pts', () => {
  const out = framePacket(PacketKind.VIDEO, { config: false, key: true, pts: 42n, data: Buffer.from([9, 9]) });
  assert.equal(out[0], 1);
  assert.equal(out[1], 2);
  assert.equal(out.readBigUInt64BE(2), 42n);
  assert.deepEqual([...out.subarray(10)], [9, 9]);
});
