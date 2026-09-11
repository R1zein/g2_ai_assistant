import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { buildAuthUrl, exchangeCode } from '../google/oauth.js';
import { ensureBookingsCalendar, getPrimaryTimeZone } from '../google/calendar.js';
import { clientForUser } from '../google/oauth.js';
import type { Store } from '../store/index.js';
import { syncMailbox } from '../bookings/sync.js';

const log = logger('routes:auth');

function page(title: string, body: string, tone: 'ok' | 'error' | 'neutral' = 'neutral'): string {
  const accent = tone === 'error' ? '#d14343' : tone === 'ok' ? '#2f8f4e' : '#232323';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #fff; color: #232323;
    font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    letter-spacing: -0.01em;
  }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #fff; } .card { background: #1a1a1a; } }
  .card { width: 100%; max-width: 420px; background: #eee; border-radius: 16px; padding: 24px; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.02em; color: ${accent}; }
  p { margin: 0 0 16px; color: #7b7b7b; }
  @media (prefers-color-scheme: dark) { p { color: #8a8a8a; } }
  code { font: 500 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; }
  .code { display: block; padding: 12px 16px; margin: 0 0 20px; border-radius: 10px;
          background: rgba(35,35,35,0.08); text-align: center; }
  @media (prefers-color-scheme: dark) { .code { background: rgba(255,255,255,0.08); } }
  a.btn { display: block; text-align: center; padding: 14px 20px; border-radius: 10px;
          background: #232323; color: #fff; text-decoration: none; font-weight: 500; }
  @media (prefers-color-scheme: dark) { a.btn { background: #fff; color: #111; } }
  ul { margin: 0; padding-left: 20px; color: #7b7b7b; }
</style>
</head><body><div class="card">${body}</div></body></html>`;
}

export function registerAuthRoutes(app: FastifyInstance, store: Store): void {
  const cfg = loadConfig();

  /** Landing page the glasses tell the user to open. */
  app.get<{ Querystring: { code?: string } }>('/link', async (request, reply) => {
    const code = (request.query.code ?? '').toUpperCase().trim();
    reply.type('text/html; charset=utf-8');

    if (!code) {
      return page(
        'Pair your glasses',
        `<h1>Pair your glasses</h1>
         <p>Open the G2 AI Assistant on your glasses, then come back to the link it shows.</p>`,
      );
    }

    const pairing = store.getPairing(code);
    if (!pairing) {
      return page(
        'Unknown code',
        `<h1>Unknown code</h1><p>That pairing code does not exist. Restart the app on your glasses to get a new one.</p>`,
        'error',
      );
    }
    if (pairing.status === 'expired') {
      return page(
        'Code expired',
        `<h1>Code expired</h1><p>Pairing codes last ${cfg.pairingTtlMinutes} minutes. Restart the app on your glasses for a fresh one.</p>`,
        'error',
      );
    }
    if (pairing.status === 'linked') {
      return page(
        'Already paired',
        `<h1>Already paired</h1><p>These glasses are connected. You can close this tab.</p>`,
        'ok',
      );
    }

    return page(
      'Connect Google',
      `<h1>Connect Google</h1>
       <p>Pairing code shown on your glasses:</p>
       <span class="code"><code>${code}</code></span>
       <p>The assistant will read your mail for reservations and manage its own calendar. It can:</p>
       <ul>
         <li>read Gmail (read-only)</li>
         <li>read your calendars and add events</li>
       </ul>
       <p></p>
       <a class="btn" href="/auth/google?code=${encodeURIComponent(code)}">Continue with Google</a>`,
    );
  });

  /** Kicks off the OAuth consent screen for a specific pairing code. */
  app.get<{ Querystring: { code?: string } }>('/auth/google', async (request, reply) => {
    const code = (request.query.code ?? '').toUpperCase().trim();
    const pairing = store.getPairing(code);

    if (!pairing || pairing.status !== 'pending') {
      reply.type('text/html; charset=utf-8').code(400);
      return page(
        'Cannot start sign-in',
        `<h1>Cannot start sign-in</h1><p>That pairing code is not waiting for an account.</p>`,
        'error',
      );
    }

    return reply.redirect(buildAuthUrl(code));
  });

  /** Google redirects here. `state` is the pairing code. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      reply.type('text/html; charset=utf-8');

      const { code, state, error } = request.query;

      if (error) {
        return page('Sign-in cancelled', `<h1>Sign-in cancelled</h1><p>Google reported: ${error}</p>`, 'error');
      }
      if (!code || !state) {
        reply.code(400);
        return page('Bad callback', `<h1>Bad callback</h1><p>Google did not send a code and state.</p>`, 'error');
      }

      const pairing = store.getPairing(state);
      if (!pairing || pairing.status !== 'pending') {
        reply.code(400);
        return page(
          'Pairing expired',
          `<h1>Pairing expired</h1><p>Restart the app on your glasses and try again.</p>`,
          'error',
        );
      }

      try {
        const identity = await exchangeCode(code);

        // Provisional record so we have a client to read the calendar timezone with.
        let user = store.upsertUser({
          email: identity.email,
          name: identity.name,
          picture: identity.picture,
          timeZone: 'UTC',
          tokens: {
            refreshToken: identity.refreshToken,
            accessToken: identity.accessToken,
            expiryDate: identity.expiryDate,
            scopes: identity.scopes,
          },
        });

        const auth = clientForUser(store, user);
        const timeZone = await getPrimaryTimeZone(auth);
        const bookingsCalendarId = await ensureBookingsCalendar(auth, timeZone);
        user = store.updateUser(user.id, { timeZone, bookingsCalendarId }) ?? user;

        store.linkPairing(state, user.id);
        log.info(`paired device ${pairing.deviceId} with ${user.email}`);

        // First scan runs in the background — the user should not wait on it.
        void syncMailbox(store, user).catch((err) =>
          log.error(`initial sync failed for ${user.email}`, err),
        );

        return page(
          'Glasses paired',
          `<h1>Glasses paired</h1>
           <p>Signed in as ${user.email}. Your glasses will pick this up in a few seconds.</p>
           <p>Scanning your recent mail for reservations now — anything it finds lands in the
              "${cfg.bookingsCalendarName}" calendar.</p>`,
          'ok',
        );
      } catch (err) {
        log.error('oauth callback failed', err);
        reply.code(500);
        return page(
          'Sign-in failed',
          `<h1>Sign-in failed</h1><p>${err instanceof Error ? err.message : String(err)}</p>`,
          'error',
        );
      }
    },
  );
}
