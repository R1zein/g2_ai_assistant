import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AccountState,
  AgendaResponse,
  AskRequest,
  AssistantAnswer,
  AssistantMode,
  PairPollResponse,
  PairStartRequest,
  PairStartResponse,
  SetApiKeyRequest,
  StreamEvent,
  VoiceAskRequest,
} from '@g2/shared';
import { ASSISTANT_MODES } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { ask } from '../ai/agent.js';
import { clientForUser, revoke } from '../google/oauth.js';
import { listEvents } from '../google/calendar.js';
import { syncMailbox } from '../bookings/sync.js';
import { hub } from '../notifications/hub.js';
import { deliverDue } from '../notifications/scheduler.js';
import { speechEnabled, SpeechUnavailableError, transcribe } from '../speech/index.js';
import { assistantReady, MissingApiKeyError, validateApiKey } from '../ai/anthropic.js';
import { encryptionAvailable } from '../util/crypto.js';
import type { DeviceRecord, Store, UserRecord } from '../store/index.js';
import { relativeTime } from '../util/time.js';
import { toAgendaItem } from '../ai/tools/index.js';

const log = logger('routes:api');

interface Session {
  device: DeviceRecord;
  user: UserRecord;
}

/** Reads the bearer token and resolves the session, or replies 401. */
function authenticate(store: Store, request: FastifyRequest, reply: FastifyReply): Session | null {
  const header = request.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const session = store.authenticate(token);

  if (!session) {
    void reply.code(401).send({
      error: 'unauthorized',
      message: 'This device is not paired, or its session expired.',
      reauth: true,
    });
    return null;
  }
  return session;
}

async function buildAgenda(store: Store, user: UserRecord, hoursAhead: number): Promise<AgendaResponse> {
  const auth = clientForUser(store, user);
  const events = await listEvents(auth, {
    timeMin: new Date(Date.now() - 60 * 60_000),
    timeMax: new Date(Date.now() + hoursAhead * 3_600_000),
    maxResults: 12,
  });

  const bookingsByEvent = new Map(
    store
      .listBookings(user.id)
      .filter((b) => b.calendarEventId)
      .map((b) => [b.calendarEventId!, b]),
  );

  return {
    timeZone: user.timeZone,
    generatedAt: new Date().toISOString(),
    items: events.map((e) => toAgendaItem(e, bookingsByEvent.get(e.id)?.type)),
  };
}

export function registerApiRoutes(app: FastifyInstance, store: Store): void {
  const cfg = loadConfig();

  /* ---------------- pairing ---------------- */

  app.post<{ Body: PairStartRequest }>('/api/pair/start', async (request, reply) => {
    const deviceId = (request.body?.deviceId ?? '').trim();
    if (!deviceId) {
      return reply.code(400).send({ error: 'bad_request', message: 'deviceId is required.' });
    }

    const pairing = store.createPairing(deviceId, request.body.deviceLabel);
    const response: PairStartResponse = {
      pairingCode: pairing.code,
      verificationUrl: `${cfg.publicBaseUrl}/link?code=${encodeURIComponent(pairing.code)}`,
      expiresAt: pairing.expiresAt,
      pollIntervalMs: 3_000,
    };
    return response;
  });

  app.post<{ Body: { pairingCode: string } }>('/api/pair/poll', async (request, reply) => {
    const code = (request.body?.pairingCode ?? '').toUpperCase().trim();
    const pairing = store.getPairing(code);

    if (!pairing) {
      return reply.code(404).send({ error: 'not_found', message: 'Unknown pairing code.' });
    }
    if (pairing.status !== 'linked' || !pairing.userId) {
      return { status: pairing.status } satisfies PairPollResponse;
    }

    const user = store.getUser(pairing.userId);
    if (!user) {
      return { status: 'expired' } satisfies PairPollResponse;
    }

    // The token is handed over exactly once; later polls just confirm the link.
    const token = store.claimPairingToken(code);
    const response: PairPollResponse = {
      status: 'linked',
      account: {
        email: user.email,
        name: user.name,
        picture: user.picture,
        timeZone: user.timeZone,
        scopes: user.tokens.scopes,
      },
    };
    if (token) response.sessionToken = token;
    return response;
  });

  /* ---------------- session ---------------- */

  app.get('/api/me', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    const state: AccountState = {
      account: {
        email: session.user.email,
        name: session.user.name,
        picture: session.user.picture,
        timeZone: session.user.timeZone,
        scopes: session.user.tokens.scopes,
      },
      lastGmailSyncAt: session.user.lastGmailSyncAt,
      bookings: store.listBookings(session.user.id).length,
      voiceEnabled: speechEnabled(),
      mode: session.user.mode ?? 'fast',
      hasOwnApiKey: Boolean(session.user.apiKeyCipher),
      apiKeyHint: session.user.apiKeyHint,
      assistantReady: assistantReady(store, session.user),
    };
    return state;
  });

  /* ---------------- mode ---------------- */

  app.post<{ Body: { mode: AssistantMode } }>('/api/mode', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    const mode = request.body?.mode;
    if (!mode || !ASSISTANT_MODES.includes(mode)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: `mode must be one of: ${ASSISTANT_MODES.join(', ')}.` });
    }

    store.setMode(session.user.id, mode);
    return { mode };
  });

  /* ---------------- Anthropic key ---------------- */

  app.post<{ Body: SetApiKeyRequest }>('/api/account/api-key', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    if (!encryptionAvailable()) {
      return reply.code(503).send({
        error: 'encryption_unavailable',
        message:
          'This server cannot store keys because ENCRYPTION_KEY is not configured. ' +
          'Ask the operator to set one.',
      });
    }

    const apiKey = (request.body?.apiKey ?? '').trim();
    if (!apiKey) {
      return reply.code(400).send({ error: 'bad_request', message: 'apiKey is required.' });
    }

    // Validate before storing, so a typo fails here rather than on the wearer's
    // next question.
    const check = await validateApiKey(apiKey);
    if (!check.ok) {
      return reply.code(400).send({ error: 'invalid_api_key', message: check.reason });
    }

    const updated = store.setUserApiKey(session.user.id, apiKey);
    log.info(`stored a personal Anthropic key for ${session.user.email}`);
    return { hasOwnApiKey: true, apiKeyHint: updated?.apiKeyHint };
  });

  app.delete('/api/account/api-key', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    store.clearUserApiKey(session.user.id);
    return { hasOwnApiKey: false };
  });

  app.delete('/api/session', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    store.revokeDevice(session.device.deviceId);
    log.info(`device ${session.device.deviceId} unpaired`);
    return { ok: true };
  });

  app.post<{ Body: { revokeGoogle?: boolean } }>('/api/account/disconnect', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    if (request.body?.revokeGoogle) await revoke(store, session.user);
    store.revokeDevice(session.device.deviceId);
    return { ok: true };
  });

  /* ---------------- agenda & bookings ---------------- */

  app.get<{ Querystring: { hours?: string } }>('/api/agenda', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    const hours = Math.min(720, Math.max(1, Number(request.query.hours ?? 36) || 36));
    try {
      return await buildAgenda(store, session.user, hours);
    } catch (err) {
      log.error('agenda failed', err);
      return reply.code(502).send({
        error: 'calendar_unavailable',
        message: err instanceof Error ? err.message : 'Google Calendar did not respond.',
      });
    }
  });

  app.get('/api/bookings', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    const now = Date.now();
    return {
      bookings: store
        .listBookings(session.user.id)
        .filter((b) => new Date(b.end ?? b.start).getTime() >= now - 86_400_000)
        .map((b) => ({ ...b, relative: relativeTime(new Date(b.start)) })),
    };
  });

  app.post<{ Body: { daysBack?: number; force?: boolean } }>('/api/sync', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    try {
      return await syncMailbox(store, session.user, {
        backfillDays: request.body?.daysBack,
        force: request.body?.force,
      });
    } catch (err) {
      log.error('manual sync failed', err);
      return reply.code(502).send({
        error: 'sync_failed',
        message: err instanceof Error ? err.message : 'Mailbox sync failed.',
      });
    }
  });

  /* ---------------- assistant ---------------- */

  app.post<{ Body: AskRequest }>('/api/ask', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    const text = (request.body?.text ?? '').trim();
    if (!text) {
      return reply.code(400).send({ error: 'bad_request', message: 'text is required.' });
    }

    try {
      const answer: AssistantAnswer = await ask({
        store,
        user: session.user,
        question: text,
        conversationId: request.body.conversationId,
        context: request.body.context,
        mode: request.body.mode,
      });
      return answer;
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        return reply.code(402).send({ error: 'no_api_key', message: err.message });
      }
      log.error('ask failed', err);
      return reply.code(502).send({
        error: 'assistant_failed',
        message: err instanceof Error ? err.message : 'The assistant could not answer.',
      });
    }
  });

  app.post<{ Body: VoiceAskRequest }>('/api/voice', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    const audioBase64 = request.body?.audioBase64 ?? '';
    if (!audioBase64) {
      return reply.code(400).send({ error: 'bad_request', message: 'audioBase64 is required.' });
    }

    let transcript: string;
    try {
      const pcm = Buffer.from(audioBase64, 'base64');
      const result = await transcribe(pcm, request.body.sampleRate ?? 16_000);
      transcript = result.text.trim();
      log.info(`transcribed ${result.durationSeconds.toFixed(1)}s -> "${transcript}"`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof SpeechUnavailableError ? 400 : 502;
      return reply.code(status).send({ error: 'transcription_failed', message });
    }

    if (!transcript) {
      return reply.code(400).send({
        error: 'empty_transcript',
        message: 'I did not catch that. Hold the touchpad and speak again.',
      });
    }

    try {
      return await ask({
        store,
        user: session.user,
        question: transcript,
        conversationId: request.body.conversationId,
        context: request.body.context,
        mode: request.body.mode,
      });
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        return reply.code(402).send({ error: 'no_api_key', message: err.message });
      }
      log.error('voice ask failed', err);
      return reply.code(502).send({
        error: 'assistant_failed',
        message: err instanceof Error ? err.message : 'The assistant could not answer.',
      });
    }
  });

  /* ---------------- notifications ---------------- */

  app.get('/api/notifications', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    const now = Date.now();
    return {
      notifications: store
        .listNotifications(session.user.id, { pendingOnly: true })
        .filter((n) => new Date(n.scheduledFor).getTime() <= now),
    };
  });

  app.post<{ Body: { ids: string[] } }>('/api/notifications/ack', async (request, reply) => {
    const session = authenticate(store, request, reply);
    if (!session) return;

    for (const id of request.body?.ids ?? []) {
      const record = store.listNotifications(session.user.id).find((n) => n.id === id);
      if (record) store.markNotificationDelivered(id);
    }
    return { ok: true };
  });

  /**
   * Server-sent events.
   *
   * EventSource cannot set headers, so the token rides in the query string —
   * over HTTPS that is no worse than a header, and it is the only option the
   * WebView gives us.
   */
  app.get<{ Querystring: { token?: string } }>('/api/stream', (request, reply) => {
    const session = store.authenticate((request.query.token ?? '').trim());
    if (!session) {
      void reply.code(401).send({ error: 'unauthorized', message: 'Bad or missing token.', reauth: true });
      return;
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: StreamEvent): void => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({
      type: 'ready',
      account: {
        email: session.user.email,
        name: session.user.name,
        picture: session.user.picture,
        timeZone: session.user.timeZone,
        scopes: session.user.tokens.scopes,
      },
    });

    const unsubscribe = hub.subscribe(session.user.id, send);

    // Anything that came due while the user was offline goes out immediately.
    setTimeout(() => deliverDue(store), 250).unref?.();

    // Proxies drop idle connections; a comment frame every 25s keeps it warm.
    const keepAlive = setInterval(() => {
      raw.write(`: keep-alive\n\n`);
    }, 25_000);
    keepAlive.unref?.();

    const cleanup = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
