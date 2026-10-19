// Runs the real ScrcpySession against a fake device: a TCP server that
// behaves like an `adb forward` tunnel to the scrcpy server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { ScrcpySession } from '../server/scrcpy.js';
import { codecId } from '../server/protocol.js';

function packet(pts, data, { config = false, key = false } = {}) {
  const h = Buffer.alloc(12);
  let v = BigInt(pts);
  if (config) v |= 1n << 63n;
  if (key) v |= 1n << 62n;
  h.writeBigUInt64BE(v, 0);
  h.writeUInt32BE(data.length, 8);
  return Buffer.concat([h, data]);
}

async function fakeDevice({ audio }) {
  const received = [];
  let connections = 0;
  const sockets = [];
  const server = net.createServer((socket) => {
    connections++;
    sockets.push(socket);
    // First attempt: scrcpy isn't listening yet, so adb closes the tunnel.
    if (connections === 1) return socket.destroy();
    const role = ['video', ...(audio ? ['audio'] : []), 'control'][connections - 2];
    if (role === 'video') {
      const name = Buffer.alloc(64);
      name.write('Fake Phone');
      const meta = Buffer.alloc(12);
      meta.writeUInt32BE(codecId('h264'), 0);
      meta.writeUInt32BE(1280, 4);
      meta.writeUInt32BE(720, 8);
      // Dummy byte and headers arrive in the same chunk on purpose.
      socket.write(Buffer.concat([Buffer.from([0]), name, meta]));
      setTimeout(() => {
        const stream = Buffer.concat([
          packet(0, Buffer.from([0, 0, 0, 1, 0x67, 0x42]), { config: true }),
          packet(1000, Buffer.from([0, 0, 0, 1, 0x65, 7, 7]), { key: true }),
          packet(2000, Buffer.from([0, 0, 0, 1, 0x41, 8])),
        ]);
        // Split awkwardly to exercise reassembly.
        socket.write(stream.subarray(0, 5));
        setTimeout(() => socket.write(stream.subarray(5)), 10);
      }, 50);
    } else if (role === 'audio') {
      const id = Buffer.alloc(4);
      id.writeUInt32BE(codecId('opus'), 0);
      socket.write(Buffer.concat([id, packet(0, Buffer.from('OpusHead'), { config: true }), packet(500, Buffer.from([1, 2, 3]))]));
    } else {
      socket.on('data', (d) => received.push(d));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    received,
    close: () => {
      sockets.forEach((s) => s.destroy());
      server.close();
    },
  };
}

function fakeAdb(port) {
  const calls = [];
  return {
    serial: 'fake:5555',
    calls,
    push: async (...a) => calls.push(['push', ...a]),
    forward: async (remote) => {
      calls.push(['forward', remote]);
      return port;
    },
    removeForward: async (p) => calls.push(['removeForward', p]),
    spawnShell(cmd) {
      calls.push(['shell', cmd]);
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => setImmediate(() => proc.emit('exit', 0));
      return proc;
    },
  };
}

const options = { codec: 'h264', maxSize: 1280, bitrate: 6_000_000, fps: 60, audio: true, keyframeInterval: 2 };

test('ScrcpySession streams video and audio and forwards control messages', async () => {
  const device = await fakeDevice({ audio: true });
  const adb = fakeAdb(device.port);
  const session = new ScrcpySession(adb, options);
  const events = { video: [], audio: [] };
  session.on('device', (n) => (events.device = n));
  session.on('video-meta', (m) => (events.videoMeta = m));
  session.on('audio-meta', (m) => (events.audioMeta = m));
  session.on('video', (p) => events.video.push(p));
  session.on('audio', (p) => events.audio.push(p));

  await session.start();
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(events.device, 'Fake Phone');
  assert.deepEqual(events.videoMeta, { codec: 'h264', width: 1280, height: 720 });
  assert.deepEqual(events.audioMeta, { codec: 'opus' });
  assert.deepEqual(events.video.map((p) => [p.config, p.key, p.pts]), [
    [true, false, 0n],
    [false, true, 1000n],
    [false, false, 2000n],
  ]);
  assert.equal(events.audio.length, 2);

  const shell = adb.calls.find((c) => c[0] === 'shell')[1];
  assert.match(shell, /com\.genymobile\.scrcpy\.Server \d+\.\d+/);
  assert.match(shell, /tunnel_forward=true/);
  assert.match(shell, /video_codec=h264/);
  assert.match(shell, /scid=[0-9a-f]{8}/);
  const scid = shell.match(/scid=([0-9a-f]{8})/)[1];
  assert.deepEqual(adb.calls.find((c) => c[0] === 'forward'), ['forward', `localabstract:scrcpy_${scid}`]);

  session.send(Buffer.from([11]));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([...Buffer.concat(device.received)], [11]);

  const closed = once(session, 'close');
  session.close('test');
  assert.deepEqual(await closed, ['test']);
  assert.ok(adb.calls.some((c) => c[0] === 'removeForward'));
  device.close();
});

test('ScrcpySession works without audio', async () => {
  const device = await fakeDevice({ audio: false });
  const session = new ScrcpySession(fakeAdb(device.port), { ...options, audio: false });
  let audioDisabled = null;
  let meta = null;
  session.on('audio-disabled', (d) => (audioDisabled = d));
  session.on('video-meta', (m) => (meta = m));
  await session.start();
  assert.deepEqual(audioDisabled, { reason: 'off' });
  assert.equal(meta.width, 1280);
  session.close();
  device.close();
});
