/** Environment-driven configuration. Read once at boot so misconfiguration fails fast. */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function opt(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function effort(name: string, fallback: Effort): Effort {
  const raw = opt(name).toLowerCase() as Effort;
  return EFFORTS.includes(raw) ? raw : fallback;
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
  dataDir: string;
  logLevel: string;

  /**
   * Shared fallback key. Optional: each account normally brings its own, which
   * is stored encrypted and billed to them.
   */
  anthropicApiKey: string;
  /** When true, an account with no personal key cannot use the assistant. */
  requireUserApiKey: boolean;
  /**
   * Assistant model. Defaults to Claude Opus 5 — the assistant reasons over
   * calendar/mail tool results, which is exactly where the extra capability pays.
   */
  assistantModel: string;
  /** Model used for the bulk email -> booking extraction pass. */
  extractionModel: string;
  /**
   * `effort` trades thoroughness for latency. The assistant answers into a HUD
   * while the user is standing still, so we default it below the API default
   * of `high`; raise it if you care more about depth than about response time.
   */
  assistantEffort: Effort;
  /** `deep` mode adds the web tools and is allowed to think harder. */
  deepEffort: Effort;
  extractionEffort: Effort;
  /** Opt into the server-side refusal fallback so a declined turn still answers. */
  refusalFallback: boolean;
  /** Hard ceiling on agent tool round-trips per question. */
  maxAgentIterations: number;
  /** Wall-clock budget for one question, in ms. */
  agentTimeoutMs: number;
  /** Same two limits, raised for `deep` mode where a web round-trip is slower. */
  deepMaxAgentIterations: number;
  deepAgentTimeoutMs: number;
  /** Cap on server-side web search / fetch calls within one question. */
  webMaxUses: number;
  /** Domains the web tools may never touch. Empty means no block list. */
  webBlockedDomains: string[];

  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;

  sttProvider: 'google' | 'openai' | 'none';
  googleSpeechApiKey: string;
  openaiApiKey: string;
  openaiSttModel: string;

  /** Gmail poll cadence in ms; 0 disables the background sync. */
  gmailSyncIntervalMs: number;
  /** How far back the first Gmail scan reaches, in days. */
  gmailBackfillDays: number;
  /** Name of the calendar bookings are written to. Created on demand. */
  bookingsCalendarName: string;
  /** Minutes before a booking starts that we push a reminder. */
  reminderLeadMinutes: number[];
  /**
   * Romanise Cyrillic before sending it to the HUD. Off by default: G2 firmware
   * falls back to an `evenroster_crylgrek` face, so Cyrillic normally renders.
   * Turn it on only if your firmware shows gaps instead of letters.
   */
  transliterateOutput: boolean;

  sessionTtlDays: number;
  pairingTtlMinutes: number;

  /** Unsplash access key. Empty disables the photo feed. */
  unsplashAccessKey: string;
  /** Name sent in the required UTM parameters on every link back. */
  unsplashAppName: string;
  /** Search term for the feed; empty means whatever Unsplash feels like. */
  photoQuery: string;
  /** Rendered frame size. Image containers cap at 288x144. */
  photoWidth: number;
  photoHeight: number;
  /** Photos fetched per API request. Batching is what keeps a demo key usable. */
  photoBatchSize: number;
  /**
   * Pixel encoding. `byte` is one entry per pixel holding 0-15 — the literal
   * reading of the SDK docs. Flip to `nibble` if hardware shows garbage.
   */
  photoPixelFormat: 'byte' | 'nibble';
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const publicBaseUrl = opt('PUBLIC_BASE_URL', 'http://localhost:8787').replace(/\/+$/, '');

  cached = {
    port: num('PORT', 8787),
    host: opt('HOST', '0.0.0.0'),
    publicBaseUrl,
    dataDir: opt('DATA_DIR', 'data'),
    logLevel: opt('LOG_LEVEL', 'info'),

    anthropicApiKey: opt('ANTHROPIC_API_KEY'),
    requireUserApiKey: bool('REQUIRE_USER_API_KEY', false),
    assistantModel: opt('ASSISTANT_MODEL', 'claude-opus-5'),
    // Extraction is a narrow, well-specified task run once per candidate email,
    // so it runs on the small model by default.
    extractionModel: opt('EXTRACTION_MODEL', 'claude-haiku-4-5'),
    assistantEffort: effort('ASSISTANT_EFFORT', 'medium'),
    deepEffort: effort('DEEP_EFFORT', 'high'),
    extractionEffort: effort('EXTRACTION_EFFORT', 'low'),
    refusalFallback: bool('REFUSAL_FALLBACK', true),
    maxAgentIterations: num('MAX_AGENT_ITERATIONS', 8),
    agentTimeoutMs: num('AGENT_TIMEOUT_MS', 45_000),
    deepMaxAgentIterations: num('DEEP_MAX_AGENT_ITERATIONS', 12),
    deepAgentTimeoutMs: num('DEEP_AGENT_TIMEOUT_MS', 90_000),
    webMaxUses: num('WEB_MAX_USES', 6),
    webBlockedDomains: opt('WEB_BLOCKED_DOMAINS')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),

    googleClientId: req('GOOGLE_CLIENT_ID'),
    googleClientSecret: req('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: opt('GOOGLE_REDIRECT_URI', `${publicBaseUrl}/auth/google/callback`),

    sttProvider: (opt('STT_PROVIDER', 'none') as Config['sttProvider']) || 'none',
    googleSpeechApiKey: opt('GOOGLE_SPEECH_API_KEY'),
    openaiApiKey: opt('OPENAI_API_KEY'),
    openaiSttModel: opt('OPENAI_STT_MODEL', 'whisper-1'),

    gmailSyncIntervalMs: num('GMAIL_SYNC_INTERVAL_MS', 15 * 60_000),
    gmailBackfillDays: num('GMAIL_BACKFILL_DAYS', 30),
    bookingsCalendarName: opt('BOOKINGS_CALENDAR_NAME', 'Travel & Bookings'),
    reminderLeadMinutes: opt('REMINDER_LEAD_MINUTES', '1440,120,30')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a),

    transliterateOutput: bool('DISPLAY_TRANSLITERATE', false),

    sessionTtlDays: num('SESSION_TTL_DAYS', 365),
    pairingTtlMinutes: num('PAIRING_TTL_MINUTES', 15),

    unsplashAccessKey: opt('UNSPLASH_ACCESS_KEY'),
    unsplashAppName: opt('UNSPLASH_APP_NAME', 'g2-ai-assistant'),
    photoQuery: opt('PHOTO_QUERY'),
    photoWidth: num('PHOTO_WIDTH', 288),
    photoHeight: num('PHOTO_HEIGHT', 144),
    photoBatchSize: num('PHOTO_BATCH_SIZE', 24),
    photoPixelFormat: opt('PHOTO_PIXEL_FORMAT', 'byte') === 'nibble' ? 'nibble' : 'byte',
  };

  return cached;
}
