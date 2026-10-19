import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const devices = list(env.ANDROID_DEVICES);

export const config = {
  root,
  port: int(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  name: env.SERVICE_NAME || 'Synapse',

  // Comma-separated ADB serials, e.g. "redroid-1:5555,redroid-2:5555,emulator-5554".
  devices,
  // Fake devices that stream an ffmpeg test pattern. Defaults to 1 when no real
  // devices are configured so the whole UI can be tried without Android.
  demoDevices: int(env.DEMO_DEVICES, devices.length ? 0 : 1),

  adbPath: env.ADB_PATH || 'adb',
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  scrcpyServerPath: env.SCRCPY_SERVER_PATH || path.join(root, 'vendor', 'scrcpy-server'),
  // Must match the scrcpy-server binary exactly; the server refuses other versions.
  scrcpyVersion: env.SCRCPY_VERSION || '3.3.1',

  // Codecs the Android devices are allowed to encode, in order of preference.
  // H.264 is the only one every Android encoder supports.
  videoCodecs: list(env.VIDEO_CODECS || 'h264'),
  audio: bool(env.AUDIO, true),
  keyframeInterval: int(env.KEYFRAME_INTERVAL, 2),

  // Upper bounds for what clients may request.
  limits: {
    maxSize: int(env.MAX_SIZE_LIMIT, 1920),
    maxBitrate: int(env.MAX_BITRATE_LIMIT, 16_000_000),
    maxFps: int(env.MAX_FPS_LIMIT, 60),
  },
  defaults: {
    maxSize: int(env.DEFAULT_MAX_SIZE, 1280),
    bitrate: int(env.DEFAULT_BITRATE, 6_000_000),
    fps: int(env.DEFAULT_FPS, 60),
  },

  // Seconds without game input before a session ends (0 = never).
  idleTimeout: int(env.IDLE_TIMEOUT, 600),
  // Hard cap on a session in minutes (0 = unlimited).
  sessionMaxMinutes: int(env.SESSION_MAX_MINUTES, 0),
  // What to do to the game when a session ends: "stop" (force-stop) or "clear" (wipe app data).
  resetMode: env.RESET_MODE === 'clear' ? 'clear' : 'stop',
  // Let players send Android HOME / RECENTS. Off by default so players stay inside the game.
  allowSystemKeys: bool(env.ALLOW_SYSTEM_KEYS, false),

  // Optional shared code players must enter to use the service.
  accessCode: env.ACCESS_CODE || '',
  // Token for installing/removing games. Admin endpoints are disabled when empty.
  adminToken: env.ADMIN_TOKEN || '',
  maxUploadBytes: int(env.MAX_UPLOAD_MB, 4096) * 1024 * 1024,

  gamesFile: env.GAMES_FILE || path.join(root, 'config', 'games.json'),
  dataDir: env.DATA_DIR || path.join(root, 'data'),
  healthInterval: int(env.HEALTH_INTERVAL, 10) * 1000,
  logLevel: env.LOG_LEVEL || 'info',
};
