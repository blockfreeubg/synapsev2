import { audioContext } from '../core/sound.js';

const TARGET_LATENCY = 0.06; // seconds of buffer we aim to keep
const MAX_LATENCY = 0.3; // beyond this we drop ahead to catch up

/** Decodes Opus packets with WebCodecs and schedules them on Web Audio. */
export class AudioPlayer {
  constructor() {
    this.ctx = audioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.nextTime = 0;
    this.decoder = new AudioDecoder({
      output: (data) => this.schedule(data),
      error: (err) => console.warn('Audio decoder error:', err),
    });
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
  }

  push({ config, pts, data }) {
    // Opus needs no extra configuration for stereo; skip the OpusHead packet.
    if (config || this.decoder.state !== 'configured') return;
    this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Number(pts), data }));
  }

  schedule(audioData) {
    try {
      const frames = audioData.numberOfFrames;
      const channels = audioData.numberOfChannels;
      const buffer = this.ctx.createBuffer(channels, frames, audioData.sampleRate);
      if (audioData.format?.endsWith('-planar')) {
        for (let ch = 0; ch < channels; ch++) {
          const plane = new Float32Array(frames);
          audioData.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
          buffer.copyToChannel(plane, ch);
        }
      } else {
        const interleaved = new Float32Array(frames * channels);
        audioData.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
        for (let ch = 0; ch < channels; ch++) {
          const plane = new Float32Array(frames);
          for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + ch];
          buffer.copyToChannel(plane, ch);
        }
      }
      const now = this.ctx.currentTime;
      if (this.nextTime < now + 0.01 || this.nextTime > now + MAX_LATENCY) this.nextTime = now + TARGET_LATENCY;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(this.nextTime);
      this.nextTime += buffer.duration;
    } finally {
      audioData.close();
    }
  }

  setMuted(muted) {
    this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  close() {
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.gain.disconnect();
  }
}
