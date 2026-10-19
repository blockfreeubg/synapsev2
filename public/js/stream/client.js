import { wsUrl } from '../core/api.js';

/**
 * WebSocket connection to one play session.
 *
 * Emits (via on): open, hello, queue, starting, video-meta, audio-meta,
 * video, audio, idle-warning, pong, end, close.
 */
export class StreamClient {
  constructor(params) {
    this.params = params;
    this.listeners = new Map();
    this.ws = null;
    this.closed = false;
    this.latency = null;
    this.bytes = 0;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return this;
  }

  emit(type, detail) {
    this.listeners.get(type)?.forEach((fn) => fn(detail));
  }

  connect() {
    const ws = new WebSocket(wsUrl('/ws/play', this.params));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.emit('open');
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'pong') this.latency = performance.now() - msg.ts;
        this.emit(msg.t, msg);
        return;
      }
      const buf = new Uint8Array(e.data);
      if (buf.length < 10) return;
      this.bytes += buf.length;
      const view = new DataView(e.data);
      const packet = {
        config: (buf[1] & 1) !== 0,
        key: (buf[1] & 2) !== 0,
        pts: view.getBigUint64(2),
        data: buf.subarray(10),
      };
      this.emit(buf[0] === 1 ? 'video' : 'audio', packet);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      const wasClosed = this.closed;
      this.closed = true;
      if (!wasClosed) this.emit('close', { code: e.code, reason: e.reason });
    };
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close(1000);
  }
}
