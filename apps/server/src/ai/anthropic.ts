import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { sha256 } from '../util/id.js';
import { SealedValueError } from '../util/crypto.js';
import type { Store, UserRecord } from '../store/index.js';

const log = logger('anthropic');

export class MissingApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingApiKeyError';
  }
}

/**
 * One SDK client per distinct key.
 *
 * Clients hold connection pools, so building a fresh one per request would be
 * wasteful; keying the cache on the hash keeps the key itself out of the map.
 */
const clients = new Map<string, Anthropic>();

function clientFor(apiKey: string): Anthropic {
  const cacheKey = sha256(apiKey);
  const existing = clients.get(cacheKey);
  if (existing) return existing;

  const client = new Anthropic({
    apiKey,
    // The agent loop enforces its own wall-clock budget; keep the per-request
    // ceiling under it so one hung call cannot eat the whole thing.
    timeout: 60_000,
    maxRetries: 2,
  });

  clients.set(cacheKey, client);
  return client;
}

export interface ResolvedClient {
  client: Anthropic;
  /** Whose key paid for this call — surfaced in the account panel. */
  source: 'user' | 'server';
}

/**
 * Picks the key for a request: the account's own if it has one, otherwise the
 * shared server key when the deployment allows it.
 */
export function anthropicFor(store: Store, user: UserRecord): ResolvedClient {
  const cfg = loadConfig();

  let userKey: string | undefined;
  try {
    userKey = store.getUserApiKey(user.id);
  } catch (err) {
    if (err instanceof SealedValueError) {
      // Falling back to the shared key here would silently bill the wrong
      // account, so make the operator fix it instead.
      throw new MissingApiKeyError(
        'Your stored Anthropic key could not be decrypted. Add it again in the app settings.',
      );
    }
    throw err;
  }

  if (userKey) return { client: clientFor(userKey), source: 'user' };

  if (cfg.requireUserApiKey) {
    throw new MissingApiKeyError(
      'This server requires your own Anthropic API key. Add one in the phone panel under "Claude API key".',
    );
  }

  if (!cfg.anthropicApiKey) {
    throw new MissingApiKeyError(
      'No Anthropic API key available. Add your own in the phone panel, or set ANTHROPIC_API_KEY on the server.',
    );
  }

  return { client: clientFor(cfg.anthropicApiKey), source: 'server' };
}

/** True when this account could run a question right now. */
export function assistantReady(store: Store, user: UserRecord): boolean {
  try {
    anthropicFor(store, user);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a key before it is stored, so a typo fails at paste time rather than
 * on the wearer's next question. `models.list` is the cheapest authenticated
 * call the API offers.
 */
export async function validateApiKey(apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!/^sk-ant-/.test(apiKey.trim())) {
    return { ok: false, reason: 'That does not look like an Anthropic key — they start with "sk-ant-".' };
  }

  try {
    await new Anthropic({ apiKey: apiKey.trim(), timeout: 15_000, maxRetries: 0 }).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, reason: 'Anthropic rejected that key.' };
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, reason: 'That key exists but is not allowed to call the Messages API.' };
    }
    log.warn('key validation could not complete', err);
    return { ok: false, reason: `Could not reach Anthropic to check the key: ${describeApiError(err)}` };
  }
}

/** Human-readable one-liner for an SDK error, safe to show in the phone panel. */
export function describeApiError(err: unknown): string {
  if (err instanceof MissingApiKeyError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key. Add a working one in the phone panel.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached — try again shortly.';
  if (err instanceof Anthropic.BadRequestError) return `Bad request to Anthropic: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
