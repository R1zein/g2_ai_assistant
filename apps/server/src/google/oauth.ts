import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { GOOGLE_SCOPES, loadConfig } from '../config.js';
import { logger } from '../logger.js';
import type { Store, UserRecord } from '../store/index.js';

const log = logger('google:oauth');

function newClient(): OAuth2Client {
  const cfg = loadConfig();
  return new google.auth.OAuth2(cfg.googleClientId, cfg.googleClientSecret, cfg.googleRedirectUri);
}

/**
 * Consent URL for the pairing flow. `state` carries the pairing code so the
 * callback knows which device to bind the account to.
 */
export function buildAuthUrl(state: string): string {
  return newClient().generateAuthUrl({
    access_type: 'offline',
    // `consent` guarantees a refresh token even when the user already granted
    // access to this client before.
    prompt: 'consent',
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
  });
}

export interface ExchangedIdentity {
  email: string;
  name?: string;
  picture?: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  scopes: string[];
}

/** Turns an OAuth `code` into tokens plus the signed-in user's identity. */
export async function exchangeCode(code: string): Promise<ExchangedIdentity> {
  const client = newClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and pair again.',
    );
  }

  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();

  if (!data.email) throw new Error('Google returned no email address for this account.');

  return {
    email: data.email,
    name: data.name ?? undefined,
    picture: data.picture ?? undefined,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? undefined,
    expiryDate: tokens.expiry_date ?? undefined,
    scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
  };
}

/**
 * An authenticated client for a stored user. Refreshed access tokens are written
 * back to the store by the `tokens` listener, so a long-lived server never has
 * to re-prompt.
 */
export function clientForUser(store: Store, user: UserRecord): OAuth2Client {
  const client = newClient();
  client.setCredentials({
    refresh_token: user.tokens.refreshToken,
    access_token: user.tokens.accessToken,
    expiry_date: user.tokens.expiryDate,
  });

  client.on('tokens', (tokens) => {
    const next = { ...user.tokens };
    if (tokens.access_token) next.accessToken = tokens.access_token;
    if (tokens.expiry_date) next.expiryDate = tokens.expiry_date;
    if (tokens.refresh_token) next.refreshToken = tokens.refresh_token;
    store.updateUser(user.id, { tokens: next });
    log.debug(`refreshed access token for ${user.email}`);
  });

  return client;
}

/** Best-effort revocation; the local session is dropped regardless. */
export async function revoke(store: Store, user: UserRecord): Promise<void> {
  try {
    await clientForUser(store, user).revokeCredentials();
  } catch (err) {
    log.warn(`revoke failed for ${user.email}`, err);
  }
}
