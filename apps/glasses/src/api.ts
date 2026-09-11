import type {
  AccountState,
  AgendaResponse,
  ApiError,
  AssistantAnswer,
  AssistantMode,
  AssistantNotification,
  ClientContext,
  PairPollResponse,
  PairStartResponse,
  StreamEvent,
  SyncResult,
} from '@g2/shared';
import { API_BASE_URL } from './config';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reauth = false,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Default per-request ceiling; BLE-free, but the phone's link can still stall. */
const DEFAULT_TIMEOUT_MS = 15_000;

export class AssistantApi {
  private token = '';

  setToken(token: string): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return this.token !== '';
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(init.headers ?? {}),
        },
      });

      const raw = await response.text();
      const parsed: unknown = raw ? JSON.parse(raw) : {};

      if (!response.ok) {
        const err = parsed as ApiError;
        throw new ApiRequestError(
          err?.message || `Request failed (${response.status})`,
          response.status,
          Boolean(err?.reauth) || response.status === 401,
        );
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof ApiRequestError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiRequestError('The server did not answer in time.', 408);
      }
      throw new ApiRequestError(
        err instanceof Error ? err.message : 'Network error.',
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- pairing ---------------- */

  startPairing(deviceId: string, deviceLabel?: string): Promise<PairStartResponse> {
    return this.request('/api/pair/start', {
      method: 'POST',
      body: JSON.stringify({ deviceId, deviceLabel }),
    });
  }

  pollPairing(pairingCode: string): Promise<PairPollResponse> {
    return this.request('/api/pair/poll', {
      method: 'POST',
      body: JSON.stringify({ pairingCode }),
    });
  }

  /* ---------------- data ---------------- */

  me(): Promise<AccountState> {
    return this.request('/api/me');
  }

  setMode(mode: AssistantMode): Promise<{ mode: AssistantMode }> {
    return this.request('/api/mode', { method: 'POST', body: JSON.stringify({ mode }) });
  }

  setApiKey(apiKey: string): Promise<{ hasOwnApiKey: boolean; apiKeyHint?: string }> {
    return this.request('/api/account/api-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
      // Validated against the Anthropic API before it is stored.
      timeoutMs: 25_000,
    });
  }

  clearApiKey(): Promise<{ hasOwnApiKey: boolean }> {
    return this.request('/api/account/api-key', { method: 'DELETE' });
  }

  agenda(hours = 36): Promise<AgendaResponse> {
    return this.request(`/api/agenda?hours=${hours}`);
  }

  sync(daysBack?: number): Promise<SyncResult> {
    return this.request('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ daysBack }),
      // A full mailbox scan runs the extraction model per message.
      timeoutMs: 120_000,
    });
  }

  pendingNotifications(): Promise<{ notifications: AssistantNotification[] }> {
    return this.request('/api/notifications');
  }

  ackNotifications(ids: string[]): Promise<{ ok: boolean }> {
    return this.request('/api/notifications/ack', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  /* ---------------- assistant ---------------- */

  ask(
    text: string,
    conversationId?: string,
    context?: ClientContext,
    mode?: AssistantMode,
  ): Promise<AssistantAnswer> {
    return this.request('/api/ask', {
      method: 'POST',
      body: JSON.stringify({ text, conversationId, context, mode }),
      // `deep` mode waits on web round-trips, so this sits above the server's
      // own 90s deep-mode budget.
      timeoutMs: 120_000,
    });
  }

  askVoice(
    audioBase64: string,
    sampleRate: number,
    conversationId?: string,
    context?: ClientContext,
    mode?: AssistantMode,
  ): Promise<AssistantAnswer> {
    return this.request('/api/voice', {
      method: 'POST',
      body: JSON.stringify({ audioBase64, sampleRate, conversationId, context, mode }),
      timeoutMs: 150_000,
    });
  }

  unpair(): Promise<{ ok: boolean }> {
    return this.request('/api/session', { method: 'DELETE' });
  }

  /* ---------------- push ---------------- */

  /**
   * Opens the notification stream.
   *
   * `EventSource` cannot carry an Authorization header, so the token goes in the
   * query string. Returns a close function.
   */
  openStream(onEvent: (event: StreamEvent) => void, onError: (err: Event) => void): () => void {
    const source = new EventSource(
      `${API_BASE_URL}/api/stream?token=${encodeURIComponent(this.token)}`,
    );

    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as StreamEvent);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };
    source.onerror = onError;

    return () => source.close();
  }
}

export const api = new AssistantApi();
