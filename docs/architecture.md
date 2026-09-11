# Architecture

```
                 Even Realities G2                     Phone (Even App)
        ┌──────────────────────────┐        ┌────────────────────────────────┐
        │  576 x 288, 16 greys     │◀──BLE──│  Flutter WebView               │
        │  touchpad + R1 ring      │        │   └─ apps/glasses  (this repo) │
        │  4-mic array             │        │        Even Hub SDK 0.0.15     │
        └──────────────────────────┘        └───────────────┬────────────────┘
                                                            │ HTTPS + SSE
                                                            ▼
                                        ┌────────────────────────────────────┐
                                        │  apps/server                       │
                                        │   ├─ Claude agent (tool use)       │
                                        │   ├─ Gmail → booking extraction    │
                                        │   ├─ Google Calendar mirror        │
                                        │   ├─ reminder scheduler            │
                                        │   └─ speech-to-text adapter        │
                                        └───────┬──────────────┬─────────────┘
                                                │              │
                                       Anthropic API    Google APIs
                                                       (Gmail, Calendar)
```

## Why there is a server at all

The Even Hub app is a web page inside a WebView. It cannot hold an Anthropic API
key, it cannot complete a Google OAuth flow, it is subject to full browser CORS,
and it only runs while the wearer has the app open. Every one of those rules out
doing the work on the glasses side.

So the glasses app is a *terminal*: it renders, captures input, and calls one
trusted backend. All credentials, all long-running work, and all scheduling live
on the server.

## Packages

| Path | What it is |
|---|---|
| `packages/shared` | The wire protocol. Types only — imported by both sides so a field rename breaks the build rather than production. |
| `apps/server` | Node 22 + Fastify. Google OAuth, Gmail scanning, calendar mirroring, the Claude agent, notifications, STT. |
| `apps/glasses` | Vite + TypeScript Even Hub app. Renders the HUD, maps touch/ring input, records push-to-talk audio, and hosts the phone-side panel. |

## Request paths

### Pairing

Consent happens in a real browser, not in the WebView, so the flow is a
device-code exchange:

1. Glasses `POST /api/pair/start` with a stable device id → short code + a URL.
2. The HUD shows both; the phone panel shows a tappable link.
3. The user opens `/link?code=…`, signs in with Google, and the callback binds
   the account to that pairing code and mints a bearer token.
4. The glasses have been polling `/api/pair/poll`; the token is handed over on
   the first poll that observes `linked`, then forgotten server-side.

Only the SHA-256 of the token is stored. The refresh token never leaves the
server.

### Asking a question

```
long-press (or menu ▸ Ask)
  → audioControl(true, Glasses)        PCM 16 kHz frames arrive via onEvenHubEvent
  → release
  → POST /api/voice { audioBase64 }
      → speech provider            → transcript
      → Claude agent loop          → tools → answer
  → paginate() → textContainerUpgrade
```

The agent loop is in `apps/server/src/ai/agent.ts`. It is hand-written rather
than using the SDK tool runner because each turn needs a per-user Google client
in the tool context, a shared wall-clock deadline, and a trace of every tool call
to echo back onto the HUD.

Tools are registered in `apps/server/src/ai/tools/` in a fixed order, because
tool definitions render first in the request and a stable array keeps the
prompt-cache prefix intact.

### Email → calendar

```
cron (15 min)  or  menu ▸ Scan mail
  → Gmail search (booking vocabulary + category:travel/reservations)
  → skip message ids already seen
  → Claude structured extraction, one email at a time
  → normalise to Booking (timezone resolution, stable identity hash)
  → upsert into the "Travel & Bookings" calendar
  → schedule lead-time reminders
  → push a card if the glasses are connected
```

Three layers of idempotency, so re-running the scan is free:

- **Message level** — `seenMessages` keyed by `userId:messageId`.
- **Booking level** — the id is a hash of `(user, type, confirmation code, start)`,
  so the same reservation confirmed twice collapses into one record.
- **Calendar level** — the event carries a `contentHash` in its private extended
  properties; an unchanged booking skips the Google write entirely.

### Notifications

The glasses hold an `EventSource` on `/api/stream`. A scheduler tick every 30
seconds delivers anything due. A notification is only marked delivered once a
live connection actually took it, so an offline wearer gets the card on their
next launch rather than losing it.

## Display model

The HUD is three text containers, rebuilt only when the layout itself changes:

```
y=0    ┌─────────────────────────────────────────────┐  header   brightness 2
       │ Next: in 2h 10m                     84%     │
y=34   ├─────────────────────────────────────────────┤  body     brightness 4
       │ 15:40  [F] LH992 Prague → Munich            │  ← isEventCapture
       │ 18:20  [H] Hotel Astoria - check-in         │
       │ …                                           │
y=254  ├─────────────────────────────────────────────┤  footer   brightness 1
       │ Hold to ask                          1/2    │
       └─────────────────────────────────────────────┘
```

`Renderer` (`apps/glasses/src/display/renderer.ts`) mounts once with
`createStartUpPageContainer`, then prefers `textContainerUpgrade` — flicker-free —
and only falls back to `rebuildPageContainer` when the layout signature changes.

Every bridge call is serialised through `GlassesBridge.run` and wrapped in its
own timeout: the SDK does not enforce either, and overlapping calls can drop the
BLE link.

Text is wrapped against the real firmware metrics via `@evenrealities/pretext`,
so a line never overflows its container.
