# Setup

Prerequisites: Node 22+, a Google account, an Anthropic API key, and a pair of
Even Realities G2 glasses with the Even App 2.2.10 or newer. The simulator works
without hardware.

## 1. Install

```bash
npm install
```

## 2. Google Cloud project

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services ▸ Library** — enable **Gmail API** and **Google Calendar API**.
   Enable **Cloud Speech-to-Text API** too if you want voice input via Google.
3. **APIs & Services ▸ OAuth consent screen**
   - User type: *External* is fine for personal use.
   - Add the scopes:
     - `.../auth/gmail.readonly`
     - `.../auth/calendar.events`
     - `.../auth/calendar.readonly`
     - `openid`, `email`, `profile`
   - Add your own Google address under **Test users**. While the app is
     unverified only test users can sign in, and their refresh tokens expire
     after seven days — fine for development, not for daily use.
4. **APIs & Services ▸ Credentials ▸ Create credentials ▸ OAuth client ID**
   - Application type: **Web application**
   - Authorised redirect URI: exactly what you will put in `GOOGLE_REDIRECT_URI`,
     e.g. `http://localhost:8787/auth/google/callback`
5. Copy the client id and secret into `.env`.

## 3. Configure the server

```bash
cp .env.example .env
$EDITOR .env          # GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY
npm run dev:server
```

`ENCRYPTION_KEY` is what lets accounts store their own Anthropic key:

```bash
openssl rand -base64 32
```

Changing it later invalidates every stored key — everyone has to paste theirs
again — so set it once and keep it.

`ANTHROPIC_API_KEY` is now optional. Leave it empty and each account adds its own
key in the phone panel, billed to them. Set it and it becomes the fallback for
accounts that have not. `REQUIRE_USER_API_KEY=true` forces everyone onto their
own key even when the fallback exists.

Check it came up:

```bash
curl localhost:8787/health
```

### PUBLIC_BASE_URL has to be reachable from the phone

The pairing link is opened in the phone's browser, so `localhost` only works if
you are testing on the same machine. On real hardware, expose the server:

```bash
cloudflared tunnel --url http://localhost:8787
# or: ngrok http 8787
```

Then set both `PUBLIC_BASE_URL` and `GOOGLE_REDIRECT_URI` to that hostname, and
add the redirect URI to the OAuth client in the Google console.

## 4. Configure the glasses app

```bash
cp apps/glasses/.env.example apps/glasses/.env
$EDITOR apps/glasses/.env      # VITE_API_BASE_URL
```

`VITE_API_BASE_URL` must also appear in the `network` permission whitelist in
`apps/glasses/app.json`:

```json
{ "name": "network", "desc": "…", "whitelist": ["https://assistant.example.com"] }
```

Both checks apply independently — the Even App enforces the whitelist, and the
browser enforces CORS on top of it. The server sends permissive CORS headers, so
the whitelist is the one you have to remember to update.

## 5. Run it

### In the simulator

```bash
npm run dev:glasses                       # terminal 1 — Vite on :5173
npx evenhub-simulator http://localhost:5173   # terminal 2
```

### On real glasses

```bash
npm run dev:glasses
cd apps/glasses && npx evenhub qr
```

Scan the QR code with the Even App. The page hot-reloads on the glasses as you
edit.

## 6. Pair

The HUD shows a link and an eight-character code. Open the link on your phone,
sign in with Google, and the glasses pick it up within a few seconds. The first
mailbox scan starts immediately and runs in the background.

## 7. Voice input (optional)

Voice is off until you choose a provider.

**Google Cloud Speech-to-Text** — enable the API, create an API key under
**Credentials**, restrict it to the Speech-to-Text API, then:

```dotenv
STT_PROVIDER=google
GOOGLE_SPEECH_API_KEY=AIza...
```

**OpenAI-compatible endpoint** — any service exposing
`/v1/audio/transcriptions`:

```dotenv
STT_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_STT_MODEL=whisper-1
```

With `STT_PROVIDER=none` the glasses say so when you hold the touchpad, and
typed questions from the phone panel still work.

## 8. Package for Even Hub

```bash
npm run pack:glasses      # → apps/glasses/g2-ai-assistant.ehpk
```

Before publishing, change `package_id` in `app.json` away from
`com.g2assistant.hud` — it has to be unique in the store, and lowercase with no
hyphens. `npx evenhub pack app.json dist --check` tells you whether an id is
free.

## Tests

```bash
npm test
```

Server tests cover the timezone resolution, HUD text shaping and the store's
pairing/idempotency rules; the glasses tests check text wrapping against the
real firmware font metrics. Neither suite calls a network API.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Google did not return a refresh token` | The account already granted access. Revoke at <https://myaccount.google.com/permissions> and pair again. |
| Pairing page loads, glasses stay on the code | `PUBLIC_BASE_URL` differs from where the phone actually reached the server, so the callback bound a different code. |
| `fetch` fails only on hardware, fine in the simulator | The host is missing from the `network` whitelist in `app.json`. |
| Voice says "too short to hear" | The long-press was released before the mic opened. Hold, wait for "Listening", then speak. |
| Answers show gaps instead of Cyrillic | Old firmware without the `evenroster_crylgrek` face. Set `DISPLAY_TRANSLITERATE=true`. |
| Bookings never appear | Check `/api/sync` output in the phone panel log. Mail older than `GMAIL_BACKFILL_DAYS` is never scanned. |
| Every question answers "no Anthropic key available" | Neither the account nor the server has one. Paste a key in the phone panel, or set `ANTHROPIC_API_KEY`. |
| "Your stored Anthropic key could not be decrypted" | `ENCRYPTION_KEY` changed since the key was saved. Paste the key again. |
| Saving a key returns 503 | The server has no `ENCRYPTION_KEY`. |
| Web questions answer "turn on web in the menu" | The account is in `fast` mode. Toggle it from the glasses menu or the phone panel. |
