import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { config } from './config.js';
import { MediaStreamParser } from './protocol.js';
import { logger } from './log.js';

const REMOTE_PATH = '/data/local/tmp/synapse-scrcpy-server.jar';

function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

// Resolves with the first chunk, or null if the socket closes first.
function firstChunk(socket, timeout) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onEnd);
      resolve(value);
    };
    const onData = (chunk) => {
      socket.pause();
      done(chunk);
    };
    const onEnd = () => done(null);
    const timer = setTimeout(onEnd, timeout);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onEnd);
  });
}

/**
 * Connect to the first scrcpy socket through an `adb forward` tunnel.
 *
 * adb accepts the TCP connection even when nothing listens on the device yet
 * and then closes it, so scrcpy sends one dummy byte once it really accepted.
 * We retry until that byte arrives. Returns the socket and any bytes that came
 * in the same chunk after the dummy byte.
 */
export async function connectFirstSocket(port, { timeout = 15_000, interval = 100, isAborted = () => false } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    if (isAborted()) throw new Error('aborted');
    try {
      const socket = await connectOnce(port);
      const chunk = await firstChunk(socket, Math.max(500, deadline - Date.now()));
      if (chunk) return { socket, leftover: chunk.subarray(1) };
      socket.destroy();
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Could not connect to scrcpy server${lastError ? `: ${lastError.message}` : ''}`);
}

/**
 * One scrcpy streaming session on an ADB device.
 *
 * Events: device(name), video-meta({codec,width,height}), video(packet),
 *         audio-meta({codec}), audio(packet), audio-disabled({reason}), close(reason)
 */
export class ScrcpySession extends EventEmitter {
  constructor(adb, options) {
    super();
    this.adb = adb;
    this.options = options;
    this.log = logger(`scrcpy ${adb.serial}`);
    this.sockets = [];
    this.closed = false;
    this.stderr = '';
  }

  serverArgs(scid) {
    const o = this.options;
    const args = [
      `scid=${scid}`,
      'log_level=info',
      'tunnel_forward=true',
      `audio=${o.audio}`,
      'control=true',
      'cleanup=true',
      `video_codec=${o.codec}`,
      `max_size=${o.maxSize}`,
      `video_bit_rate=${o.bitrate}`,
      `max_fps=${o.fps}`,
      'stay_awake=true',
      'power_off_on_close=false',
      'clipboard_autosync=false',
    ];
    if (o.keyframeInterval > 0) {
      // Frequent keyframes let a client recover quickly after dropped frames.
      args.push(`video_codec_options=i-frame-interval=${o.keyframeInterval}`);
    }
    if (o.audio) args.push('audio_codec=opus');
    return args;
  }

  async start() {
    const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
    await this.adb.push(config.scrcpyServerPath, REMOTE_PATH);
    this.port = await this.adb.forward(`localabstract:scrcpy_${scid}`);

    const cmd = `CLASSPATH=${REMOTE_PATH} app_process / com.genymobile.scrcpy.Server ${config.scrcpyVersion} ${this.serverArgs(scid).join(' ')}`;
    this.log.debug(cmd);
    this.proc = this.adb.spawnShell(cmd);
    let exited = false;
    const onOutput = (chunk) => {
      const text = chunk.toString();
      this.stderr = (this.stderr + text).slice(-4000);
      for (const line of text.split('\n')) if (line.trim()) this.log.debug(line.trim());
    };
    this.proc.stdout.on('data', onOutput);
    this.proc.stderr.on('data', onOutput);
    this.proc.on('exit', (code) => {
      exited = true;
      this.log.debug(`server exited (${code})`);
      this.close('device-server-exited');
    });

    let video;
    try {
      video = await connectFirstSocket(this.port, { isAborted: () => exited || this.closed });
    } catch (err) {
      const detail = this.stderr.split('\n').filter((l) => /error|exception/i.test(l)).slice(-3).join(' ');
      throw new Error(detail ? `scrcpy failed to start: ${detail}` : err.message);
    }
    this.track(video.socket);
    const audio = this.options.audio ? this.track(await connectOnce(this.port)) : null;
    this.control = this.track(await connectOnce(this.port));
    // Device -> client messages (clipboard, UHID output) are not used; drain them.
    this.control.on('data', () => {});

    const videoParser = new MediaStreamParser({ kind: 'video', deviceMeta: true });
    videoParser.on('device', (name) => this.emit('device', name));
    videoParser.on('meta', (meta) => this.emit('video-meta', meta));
    videoParser.on('packet', (p) => this.emit('video', p));
    videoParser.on('disabled', ({ reason }) => this.close(`video-${reason}`));
    videoParser.on('error', (err) => this.close(err.message));
    video.socket.on('data', (chunk) => videoParser.feed(chunk));
    if (video.leftover.length) videoParser.feed(video.leftover);
    video.socket.resume();

    if (audio) {
      const audioParser = new MediaStreamParser({ kind: 'audio' });
      audioParser.on('meta', (meta) => this.emit('audio-meta', meta));
      audioParser.on('packet', (p) => this.emit('audio', p));
      audioParser.on('disabled', (info) => this.emit('audio-disabled', info));
      audioParser.on('error', (err) => this.emit('audio-disabled', { reason: err.message }));
      audio.on('data', (chunk) => audioParser.feed(chunk));
    } else {
      this.emit('audio-disabled', { reason: 'off' });
    }
  }

  track(socket) {
    this.sockets.push(socket);
    socket.on('error', () => {});
    socket.on('close', () => this.close('socket-closed'));
    return socket;
  }

  send(buf) {
    if (!this.closed && this.control?.writable) this.control.write(buf);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.proc?.kill();
    if (this.port) this.adb.removeForward(this.port);
    this.emit('close', reason);
  }
}
