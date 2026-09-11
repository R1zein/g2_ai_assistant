# Getting into Even Hub

Three stages, in this order: run it on your own glasses over the LAN, deploy the
server somewhere public, then pack and submit.

Stage one needs nothing but a laptop. Stage two is where most of the work is —
this app is not self-contained, and that shapes everything below.

## What Even Hub actually receives

A `.ehpk` is a zip of `dist/` plus `app.json`. That is the whole app as far as
the store is concerned: static files that run in a WebView on the phone.

Our server is **not** in that bundle. It holds the Google refresh tokens, the
Anthropic key and the booking database, and it has to be reachable over HTTPS
from every user's phone before the app does anything useful. Decide where it
lives before you submit — a reviewer will open the app, and the app will try to
reach that host.

## 1. On your own glasses, over the LAN

No account and no packaging needed.

```bash
npm run dev:server                 # terminal 1
npm run dev:glasses                # terminal 2 — Vite on :5173, bound to 0.0.0.0
cd apps/glasses && npx evenhub qr  # terminal 3
```

`evenhub qr` finds your LAN address and prints a QR code. Scan it in the Even
App and the page loads on the glasses with hot reload — edit `src/`, the HUD
redraws.

Set `VITE_API_BASE_URL` to your machine's LAN address, not `localhost`: the page
runs on the phone, so `localhost` there is the phone.

```bash
# apps/glasses/.env
VITE_API_BASE_URL=http://192.168.1.20:8787
```

For pairing to complete you also need `PUBLIC_BASE_URL` reachable from the
phone's browser, because that is where the Google consent screen returns to.

## 2. Deploy the server

Any host that gives you a stable HTTPS URL. The server is a plain Node 22
process with a JSON file for state, so a small VPS, Fly.io, Railway or a
Raspberry Pi behind a tunnel all work.

```bash
npm run build
node apps/server/dist/index.js     # reads .env
```

What has to be true before you pack:

- **HTTPS.** The bearer token and every calendar answer cross this link. The
  pack script refuses a plain-HTTP host that is not localhost.
- **`PUBLIC_BASE_URL`** is the public URL, and **`GOOGLE_REDIRECT_URI`** is
  `<that URL>/auth/google/callback`, registered byte-for-byte on the OAuth
  client in the Google console.
- **`ENCRYPTION_KEY`** is set and will not change. Rotating it invalidates every
  stored Anthropic key.
- **`DATA_DIR`** is on a volume that survives restarts. On a platform with an
  ephemeral filesystem, mount one — otherwise every redeploy unpairs everybody.

### Google verification

This is the part that takes real time, and it is worth knowing before you plan a
launch date.

`gmail.readonly` is a **restricted** scope. While your OAuth consent screen is
unverified, only accounts you list under **Test users** can sign in, and their
refresh tokens expire after seven days — so the app silently stops working every
week. That is fine for yourself and a handful of testers.

To open it to everyone, Google requires app verification plus a security
assessment for restricted scopes. Budget weeks, not days. If that is not where
you want to be, ship it as a self-hosted app: each user runs their own server
with their own OAuth client, and stays their own test user.

## 3. Pack

```bash
cd apps/glasses
npm run pack
```

That runs three steps: `vite build`, then `scripts/prepare-manifest.mjs`, then
`evenhub pack`.

The middle step exists because of one specific failure. The Even App enforces
the `network` permission whitelist in `app.json`, and browser CORS applies on
top of it. If the whitelist does not name the host the app calls, every request
fails **on real hardware while the simulator keeps working** — the two are
separate files that have to agree by hand.

So `app.json` stays a tracked template with a placeholder, and the script stamps
the real origin from `VITE_API_BASE_URL` into `app.build.json` (gitignored).
They cannot drift. It refuses to produce a manifest when:

- `VITE_API_BASE_URL` is unset or not a URL
- the host is plain HTTP and not localhost
- the host is still `*.example.com`
- `package_id` is still `com.example.*`

Before your first submission, change `package_id` in `app.json` — it must be
unique in the store, lowercase letters and digits per segment, no hyphens:

```bash
npx evenhub login -e you@example.com
npx evenhub pack app.build.json dist -c    # is the id free?
```

### app.json rules that will bite

| Field | Rule |
|---|---|
| `package_id` | Reverse domain, min two segments, each starting with a lowercase letter, lowercase and digits only. **No hyphens.** |
| `edition` | Exactly `"202601"`. |
| `name` | 20 characters maximum. |
| `version` | Three-part semver. No `v`, no pre-release suffix. |
| `min_sdk_version` | Match the SDK you build against — `0.0.15`. |
| `min_app_version` | The CLI stamps this from the SDK's own floor (2.2.10 for 0.0.15) and overrides a lower value unless you pass `--enforce-manual-version`. |
| `permissions` | Array of objects with `name` and `desc`. Never a key-value map. |
| `supported_languages` | Only `en de fr es it zh ja ko`. Russian is not on the list — the assistant still answers in Russian, the field just describes store metadata. |

Our three permissions and what a reviewer will read:

```jsonc
{ "name": "network",        "whitelist": ["https://your-server"] },  // required, our whole backend
{ "name": "location" },                                              // "how far", "can I make it"
{ "name": "g2-microphone" }                                          // push-to-talk
```

Write the `desc` strings for a human deciding whether to grant them. They are
the only explanation the user gets.

## 4. Submit

There is no `evenhub publish` — the CLI stops at producing a `.ehpk`. Submission
happens in the developer portal at **hub.evenrealities.com**, where you upload
the file, add store metadata and the app icon, and send it for review.

I could not open the portal from this environment, so I cannot describe its
submission form field by field — check it against what you see there.

The icon is not part of `app.json`; it is uploaded in the portal. The G2 wants a
24x24 monochrome icon, designed at that size rather than scaled down from
something larger — at 24 pixels a scaled-down logo turns to mush. Test it against
the green-on-black rendering, not against your monitor.

### If the photo feed is enabled

Unsplash's own production approval is separate from Even Hub's review and has
its own checklist. The one item this app cannot meet literally is hotlinking —
the glasses cannot resolve a URL, so the server re-encodes each photo to 4-bit
greyscale. `docs/photo-feed.md` explains what is done instead and what to say
when applying. A Demo key (50 requests an hour) needs no approval at all.

### Expect questions about this app specifically

It reads the user's mailbox, sends email bodies to a third party, and records
audio. Have a straight answer ready for each:

- **Why Gmail?** Read-only, and only to find reservations. Nothing is sent.
- **Where do email bodies go?** To the Anthropic API for extraction, under a
  commercial data policy with no training on API data. The database keeps the
  extracted fields, not the message body.
- **Where does audio go?** To the configured speech provider, one request per
  push-to-talk, never stored.
- **Whose API key pays?** Each user's own, stored encrypted.

`docs/architecture.md` has the details if you need to point at something.

## Updating a published app

Bump `version` in `app.json`, `npm run pack`, upload the new `.ehpk`. The
`package_id` stays the same — that is what identifies the app across versions.

If the server URL changes, the whitelist changes with it, which means a new
build and a new review. Put the server on a hostname you control and can
re-point, rather than a tunnel URL that rotates.
