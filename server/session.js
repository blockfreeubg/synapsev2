import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { controlFromClient, framePacket, PacketKind } from './protocol.js';
import { logger } from './log.js';

const log = logger('session');

// Above this many queued bytes we start dropping video until the next keyframe.
const HIGH_WATER = 1.5 * 1024 * 1024;
const KNOWN_CODECS = ['h264', 'h265', 'av1'];

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function streamOptions(params, device) {
  const { limits, defaults } = config;
  const clientCodecs = (params.get('codecs') || 'h264').split(',').filter((c) => KNOWN_CODECS.includes(c));
  const codec = device.codecs.find((c) => clientCodecs.includes(c));
  return {
    codec,
    maxSize: clampInt(params.get('maxSize'), 360, limits.maxSize, Math.min(defaults.maxSize, limits.maxSize)),
    bitrate: clampInt(params.get('bitrate'), 500_000, limits.maxBitrate, Math.min(defaults.bitrate, limits.maxBitrate)),
    fps: clampInt(params.get('fps'), 15, limits.maxFps, Math.min(defaults.fps, limits.maxFps)),
    audio: config.audio && params.get('audio') !== '0',
    keyframeInterval: config.keyframeInterval,
  };
}

export class PlaySession {
  constructor(ws, { pool, library, params }) {
    this.id = randomUUID().slice(0, 8);
    this.ws = ws;
    this.pool = pool;
    this.library = library;
    this.params = params;
    this.pkg = params.get('pkg');
    this.ended = false;
    this.dropping = false;
    this.dropped = 0;
    this.lastInput = Date.now();
    this.startedAt = null;

    ws.on('message', (data, isBinary) => !isBinary && this.onMessage(data));
    ws.on('close', () => this.end('client-closed'));
    ws.on('error', () => this.end('client-error'));
  }

  send(msg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async run() {
    const game = this.library.get(this.pkg);
    if (!game) return this.end('error', 'This game is not in the library.');
    if (!game.devices) return this.end('error', 'No online device has this game installed.');

    this.send({ t: 'hello', session: this.id, idleTimeout: config.idleTimeout, maxMinutes: config.sessionMaxMinutes });
    this.ticket = this.pool.acquire(this.pkg, (position, total) => this.send({ t: 'queue', position, total }));
    let device;
    try {
      device = await this.ticket.promise;
    } catch {
      return; // cancelled because the client left
    }
    this.device = device;
    if (this.ended) return this.releaseDevice();

    const options = streamOptions(this.params, device);
    if (!options.codec) {
      return this.end('error', `Your browser can't decode the video this server sends (${device.codecs.join(', ')}). Try Chrome, Edge or Safari.`);
    }
    this.send({ t: 'starting', device: { id: device.id, ...device.info } });
    log.info(`${this.id} ${this.pkg} on ${device.id} (${options.codec}, max ${options.maxSize}px, ${options.fps} fps)`);

    // While the device is starting, end() must not hand it back to the pool.
    this.starting = true;
    let stream;
    try {
      stream = await device.openSession(this.pkg, options, (s) => this.wireStream(s));
    } catch (err) {
      this.starting = false;
      log.warn(`${this.id} failed to start: ${err.message}`);
      if (this.ended) return this.releaseDevice();
      return this.end('error', `Could not start the game: ${err.message}`);
    }
    this.starting = false;
    if (this.ended) {
      stream.close('client-gone');
      return this.releaseDevice();
    }
    this.stream = stream;
    // The stream may have died while start-up was finishing.
    if (stream.closed) return this.end('device-closed', 'The device stopped streaming.');
    this.startedAt = Date.now();
    this.lastInput = Date.now();
    this.timer = setInterval(() => this.tick(), 5_000);
  }

  wireStream(stream) {
    let deviceName = null;
    stream.on('device', (name) => (deviceName = name));
    stream.on('video-meta', (meta) => this.send({ t: 'video-meta', ...meta, deviceName }));
    stream.on('audio-meta', (meta) => this.send({ t: 'audio-meta', ...meta }));
    stream.on('audio-disabled', ({ reason }) => this.send({ t: 'audio-meta', codec: null, reason }));
    stream.on('video', (packet) => this.forwardVideo(packet));
    stream.on('audio', (packet) => {
      if (this.ws.bufferedAmount < HIGH_WATER) this.sendBinary(framePacket(PacketKind.AUDIO, packet));
    });
    stream.on('close', (reason) => {
      // During start-up the failure is reported by openSession() instead.
      if (this.starting) return;
      this.end('device-closed', reason === 'device-server-exited' ? 'The device stopped streaming.' : `Stream ended (${reason}).`);
    });
  }

  forwardVideo(packet) {
    if (packet.config) return this.sendBinary(framePacket(PacketKind.VIDEO, packet));
    if (this.ws.bufferedAmount > HIGH_WATER) {
      // Dropping a delta frame corrupts every frame until the next keyframe,
      // so once we drop one we skip ahead to the next keyframe.
      this.dropping = true;
      this.dropped++;
      return;
    }
    if (this.dropping && !packet.key) {
      this.dropped++;
      return;
    }
    this.dropping = false;
    this.sendBinary(framePacket(PacketKind.VIDEO, packet));
  }

  sendBinary(buf) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(buf, { binary: true });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === 'ping') return this.send({ t: 'pong', ts: msg.ts, dropped: this.dropped });
    if (msg.t === 'active') {
      this.lastInput = Date.now();
      this.warned = false;
      return;
    }
    if (!this.stream) return;
    const buf = controlFromClient(msg, { allowSystemKeys: config.allowSystemKeys });
    if (!buf) return;
    this.lastInput = Date.now();
    this.warned = false;
    this.stream.send(buf);
  }

  tick() {
    const now = Date.now();
    if (config.idleTimeout > 0) {
      const idle = (now - this.lastInput) / 1000;
      const remaining = Math.round(config.idleTimeout - idle);
      if (remaining <= 0) return this.end('idle', 'Session ended after no input.');
      if (remaining <= 60 && !this.warned) {
        this.warned = true;
        this.send({ t: 'idle-warning', seconds: remaining });
      }
    }
    if (config.sessionMaxMinutes > 0 && now - this.startedAt > config.sessionMaxMinutes * 60_000) {
      this.end('time-limit', 'You reached the session time limit.');
    }
  }

  end(reason, message) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.ticket?.cancel();
    if (reason !== 'client-closed' && reason !== 'client-error') {
      this.send({ t: 'end', reason, message });
      setTimeout(() => this.ws.close(1000), 50);
    }
    if (this.startedAt) log.info(`${this.id} ended (${reason}) after ${Math.round((Date.now() - this.startedAt) / 1000)}s`);
    this.stream?.removeAllListeners('close');
    this.stream?.close('session-ended');
    if (!this.starting) this.releaseDevice();
  }

  async releaseDevice() {
    const device = this.device;
    if (!device || this.released) return;
    this.released = true;
    try {
      await device.closeSession(this.pkg);
    } catch (err) {
      log.warn(`${device.id} cleanup failed: ${err.message}`);
    }
    this.pool.release(device);
  }
}
