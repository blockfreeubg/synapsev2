import { codecString, withConfig } from './codecs.js';

const MAX_DECODE_QUEUE = 6;

/** Decodes the device's video with WebCodecs and paints it on a canvas. */
export class VideoRenderer {
  constructor(canvas, { onSize } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.onSize = onSize;
    this.codecName = null;
    this.codec = null;
    this.config = null;
    this.decoder = null;
    this.needKey = true;
    this.pending = null;
    this.paused = false;
    this.width = 0;
    this.height = 0;
    this.stats = { frames: 0, dropped: 0, bytes: 0 };
  }

  setCodec(name) {
    if (name !== this.codecName) {
      this.codecName = name;
      this.closeDecoder();
    }
  }

  closeDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.needKey = true;
  }

  createDecoder() {
    this.closeDecoder();
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (err) => {
        console.warn('Video decoder error:', err);
        // Recreated from the cached parameter sets at the next keyframe.
        this.decoder = null;
        this.needKey = true;
      },
    });
    this.decoder.configure({ codec: this.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
    this.needKey = true;
  }

  push({ config, key, pts, data }) {
    this.stats.bytes += data.length;
    if (!this.codecName) return;
    if (config) {
      this.config = data;
      const codec = codecString(this.codecName, data);
      if (codec !== this.codec || !this.decoder) {
        this.codec = codec;
        this.createDecoder();
      }
      return;
    }
    if (!this.config) return;
    if (!this.decoder) {
      if (!key) return;
      this.createDecoder();
    }
    if (this.needKey && !key) {
      this.stats.dropped++;
      return;
    }
    if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE && !key) {
      // The decoder can't keep up; skipping a delta frame means waiting for
      // the next keyframe, which beats building up seconds of latency.
      this.needKey = true;
      this.stats.dropped++;
      return;
    }
    const chunk = new EncodedVideoChunk({
      type: key ? 'key' : 'delta',
      timestamp: Number(pts),
      data: key ? withConfig(this.codecName, this.config, data) : data,
    });
    try {
      this.decoder.decode(chunk);
      if (key) this.needKey = false;
    } catch (err) {
      console.warn('decode failed', err);
      this.needKey = true;
    }
  }

  onFrame(frame) {
    // Keep only the newest frame; paint it on the next animation frame.
    this.pending?.close();
    this.pending = frame;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.paint());
  }

  paint() {
    this.raf = 0;
    const frame = this.pending;
    this.pending = null;
    if (!frame) return;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.onSize?.(w, h);
    }
    if (!this.paused) this.ctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.stats.frames++;
  }

  /** Grab the current picture as a PNG blob. */
  snapshot() {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.pending?.close();
    this.pending = null;
    this.closeDecoder();
  }
}
