# Server API

Base URL: `PUBLIC_BASE_URL`. All device endpoints authenticate with
`Authorization: Bearer <sessionToken>`. Types live in `packages/shared`.

## Pairing

### `POST /api/pair/start`
```jsonc
// request
{ "deviceId": "9b1c…", "deviceLabel": "Even G2" }
// response
{
  "pairingCode": "MNNA-2KGX",
  "verificationUrl": "https://…/link?code=MNNA-2KGX",
  "expiresAt": "2026-09-11T10:27:16.437Z",
  "pollIntervalMs": 3000
}
```

### `POST /api/pair/poll`
```jsonc
{ "pairingCode": "MNNA-2KGX" }
// → { "status": "pending" }
// → { "status": "linked", "sessionToken": "…", "account": { … } }
// → { "status": "expired" }
```
`sessionToken` is returned on the **first** poll that observes `linked` and never
again.

## Session

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/me` | `AccountState`: account, timezone, booking count, voice availability, current mode, whether a personal API key is on file, and whether the assistant can answer at all. |
| `POST` | `/api/mode` | `{ "mode": "fast" \| "deep" }` — the account default. |
| `POST` | `/api/account/api-key` | `{ "apiKey": "sk-ant-…" }`. Validated against Anthropic, then stored encrypted. Returns `{ hasOwnApiKey, apiKeyHint }`. |
| `DELETE` | `/api/account/api-key` | Forget the personal key and fall back to the shared one. |
| `DELETE` | `/api/session` | Unpair this device. |
| `POST` | `/api/account/disconnect` | Unpair, and with `{"revokeGoogle":true}` revoke the Google grant too. |

The key is never returned by any endpoint — only its last four characters.
`POST /api/account/api-key` answers `503 encryption_unavailable` when the server
has no `ENCRYPTION_KEY`, and `400 invalid_api_key` when Anthropic rejects it.

## Data

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agenda?hours=36` | Merged calendar view with `relative` strings computed server-side. |
| `GET` | `/api/bookings` | Extracted reservations with confirmation codes and addresses. |
| `POST` | `/api/sync` | Run a mailbox scan now. `{ "daysBack": 7, "force": false }`. Slow — one model call per candidate email. |

## Assistant

### `POST /api/ask`
```jsonc
{
  "text": "when do I check in?",
  "conversationId": "…",            // omit to start a thread
  "mode": "deep",                   // omit to use the account default
  "context": {
    "location": { "latitude": 50.08, "longitude": 14.42, "accuracy": 12 },
    "timeZone": "Europe/Prague",
    "locale": "en-GB",
    "battery": 84
  }
}
```

Response (`AssistantAnswer`):
```jsonc
{
  "conversationId": "…",
  "question": "when do I check in?",
  "answer": "15:00 today at Hotel Astoria, Namesti Republiky 7. Ref BK-4471209.",
  "steps": [
    { "tool": "list_bookings", "summary": "Read 2 saved bookings", "ok": true, "durationMs": 41 }
  ],
  "items": [ /* AgendaItem[] */ ],
  "sources": [
    { "title": "Flight status", "url": "https://www.lufthansa.com/…", "host": "lufthansa.com" }
  ],
  "meta": {
    "model": "claude-opus-5",
    "mode": "fast",
    "inputTokens": 4821, "outputTokens": 96, "cacheReadTokens": 3900,
    "webSearches": 0, "webFetches": 0,
    "latencyMs": 2140, "truncated": false
  }
}
```

`sources` is populated in `deep` mode from the pages the model actually read. It
is empty rather than absent when a search failed — a failed `web_search_tool_result`
carries an error object where the result array would be, and the extractor skips it.

`402 no_api_key` means the account has no usable Anthropic key. The glasses show
the message and point at the phone panel.

### `POST /api/voice`
Same as `/api/ask`, but takes `audioBase64` — raw PCM, 16 kHz, signed 16-bit
little-endian, mono, exactly as the Even Hub SDK delivers it. `question` in the
response carries the transcript.

Failures are distinguishable: `400 transcription_failed` means the audio was
unusable (too short, silence, no provider), `502` means the provider itself
broke.

## Notifications

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/notifications` | Anything due but not yet delivered. |
| `POST` | `/api/notifications/ack` | `{ "ids": ["…"] }` |
| `GET` | `/api/stream?token=…` | Server-sent events. |

`EventSource` cannot set headers, so the stream takes its token in the query
string. Frames are `StreamEvent`:

```jsonc
{ "type": "ready", "account": { … } }
{ "type": "notification", "notification": { … } }
{ "type": "agenda", "agenda": { … } }
```

A `: keep-alive` comment goes out every 25 s so proxies do not drop the
connection.

## Errors

```jsonc
{ "error": "unauthorized", "message": "…", "reauth": true }
```

`reauth: true` means the token is dead and the app should restart pairing. The
glasses client does this automatically.

## Browser routes

| Path | Purpose |
|---|---|
| `GET /link?code=…` | The page the wearer opens on their phone. |
| `GET /auth/google?code=…` | Redirect into Google consent. |
| `GET /auth/google/callback` | OAuth callback; `state` carries the pairing code. |
| `GET /health` | Liveness, configured models, paired user count. |
