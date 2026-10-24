/** Environment-driven configuration for the esgram bot. Read once at boot. */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example (BOT section).`,
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

function ids(name: string): Set<number> {
  return new Set(
    opt(name)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n !== 0),
  );
}

export interface BotConfig {
  /** Token from @BotFather. Never commit it — keep it in .env only. */
  token: string;
  dataDir: string;
  logLevel: string;
  /**
   * Telegram user IDs that own the bot: always allowed to run admin commands
   * and to open the web panel. Group admins are also allowed inside their own
   * group, but owners work everywhere.
   */
  ownerIds: Set<number>;
  /** How many edit records to keep per chat before dropping the oldest. */
  editLogLimit: number;
  /** In-memory text cache size for computing edit diffs (entries, global). */
  textCacheLimit: number;

  /** Web admin panel. Disabled if the token is empty. */
  webEnabled: boolean;
  webPort: number;
  webHost: string;
  /** Shared secret for the panel, passed as ?token= or an x-bot-token header. */
  webToken: string;
}

let cached: BotConfig | null = null;

export function loadBotConfig(): BotConfig {
  if (cached) return cached;
  const webToken = opt('BOT_WEB_TOKEN');
  cached = {
    token: req('BOT_TOKEN'),
    dataDir: opt('BOT_DATA_DIR', 'data/bot'),
    logLevel: opt('LOG_LEVEL', 'info'),
    ownerIds: ids('BOT_OWNER_IDS'),
    editLogLimit: num('BOT_EDIT_LOG_LIMIT', 500),
    textCacheLimit: num('BOT_TEXT_CACHE_LIMIT', 5000),
    webEnabled: webToken !== '',
    webPort: num('BOT_WEB_PORT', 8788),
    webHost: opt('BOT_WEB_HOST', '0.0.0.0'),
    webToken,
  };
  return cached;
}
