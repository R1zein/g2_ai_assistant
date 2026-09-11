import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: loadConfig().anthropicApiKey,
      // The agent loop already enforces its own wall-clock budget; keep the
      // per-request ceiling below it so a hung call cannot eat the whole budget.
      timeout: 60_000,
      maxRetries: 2,
    });
  }
  return client;
}

/** Human-readable one-liner for an SDK error, safe to show in the phone panel. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic API key rejected.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached — try again shortly.';
  if (err instanceof Anthropic.BadRequestError) return `Bad request to Anthropic: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
