/**
 * Build-time configuration.
 *
 * `VITE_API_BASE_URL` must match the host whitelisted under the `network`
 * permission in app.json — the Even App enforces that list, and CORS applies on
 * top of it.
 */
const RAW_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export const API_BASE_URL = RAW_BASE.replace(/\/+$/, '') || inferDevBase();

/** In the simulator the server usually runs on the same host, port 8787. */
function inferDevBase(): string {
  if (typeof location === 'undefined') return 'http://localhost:8787';
  return `${location.protocol}//${location.hostname}:8787`;
}

export const DISPLAY = {
  width: 576,
  height: 288,
  /** LVGL line box on G2, fixed by the firmware. */
  lineHeight: 27,
} as const;

export const LAYOUT = {
  header: { y: 0, height: 30 },
  body: { y: 34, height: 216 },
  footer: { y: 254, height: 30 },
  padding: 6,
} as const;

/** Text brightness levels (0..4); the chrome sits below the content. */
export const BRIGHTNESS = { chrome: 2, body: 4, dim: 1 } as const;

export const VOICE = {
  sampleRate: 16_000,
  /** Push-to-talk hard stop, so a stuck long-press cannot stream forever. */
  maxSeconds: 20,
  /** Cap on the base64 payload we will POST. */
  maxBytes: 16_000 * 2 * 20,
} as const;

export const STORAGE_KEYS = {
  deviceId: 'g2ai.deviceId',
  sessionToken: 'g2ai.sessionToken',
  accountEmail: 'g2ai.accountEmail',
} as const;
