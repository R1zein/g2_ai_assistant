# Photo feed

A swipeable feed of photographs on the glasses, rendered to the 4-bit display.

The point is not the photos — it is the image path. Until now the app only ever
drew text. This builds the whole pipeline from a source image to pixels the
firmware accepts, which is what anything visual needs later: maps, charts,
QR codes, navigation arrows.

## Why photos and not video

Video does not work on this hardware, and it is not a tuning problem.
`updateImageRawData` takes half a second to two seconds per frame over BLE,
there is no delta encoding, and calls must not overlap — so the ceiling is
roughly 0.5-2 fps against the 24-30 fps video needs. The G2 also has no speaker.

Photographs sidestep all of it. Nobody looks at a still for less than two
seconds, so the transfer time stops being a limitation and becomes the pace of
the feed.

## The pipeline

Everything happens on the server; the glasses receive finished pixels.

```
Unsplash /photos/random?count=24     one request, twenty-four photos
        ↓
download the `regular` size
        ↓
sharp: resize 288x144 `cover`        crop rather than letterbox — unlit bars
       + grayscale                   waste half the display
        ↓
stretchContrast (1% clip)            black is *off* on this display, so a dark
                                     photo nearly vanishes without this
        ↓
Floyd-Steinberg to 16 levels         naive rounding bands skies into stripes
        ↓
encode: one byte per pixel, 0-15
        ↓
base64 → glasses → updateImageRawData
```

`apps/server/src/photos/dither.ts` holds the quantisation, contrast stretch and
nibble packing as pure functions; `render.ts` drives sharp around them.

## The pixel format is unverified

The SDK documents image data as "4-bit greyscale (values 0-15 per pixel)" and
accepts `number[] | Uint8Array | ArrayBuffer | base64`. That leaves two readings,
and the docs do not say which the firmware wants:

- **`byte`** (default) — one array entry per pixel holding 0-15. This is the
  literal reading, and the host side is a Dart `List<int>`, which fits.
- **`nibble`** — two pixels per byte, high nibble first, rows padded to a whole
  byte.

I could not test on hardware. **If photos come out as noise, stripes, or
half-width garbage, set `PHOTO_PIXEL_FORMAT=nibble` and try again.** Both paths
are implemented and tested; only the choice between them is unconfirmed.

A third possibility: the SDK may convert common image formats itself and only
return `imageToGray4Failed` when it cannot. If both raw formats fail, sending an
encoded PNG is worth trying before assuming the container is wrong.

## Rate limits shape the design

A new Unsplash app is in **Demo** mode: 50 requests per hour. One request per
swipe would run dry after fifty swipes.

So the feed is fetched in batches — `/photos/random?count=24` costs one request
and yields twenty-four photos. The same budget becomes over a thousand photos an
hour. Batches are cached per user for thirty minutes.

Production approval raises this to **1,000 per hour** and wants screenshots
showing correct attribution.

## Attribution

Unsplash's API terms require a visible credit to the photographer and to
Unsplash, linked, with UTM parameters. A monochrome HUD cannot carry a tappable
link, so the requirement is met across both surfaces:

- **Glasses** — a credit line under the photo: `photo: Jane Doe / Unsplash`.
- **Phone panel** — the same credit with real links, carrying
  `utm_source=<UNSPLASH_APP_NAME>&utm_medium=referral`.

The terms also require pinging `links.download_location` when a photo is
actually used. Showing one on the glasses counts, so the server fires it once
per photo — never awaited, because the wearer is waiting on pixels.

## Hotlinking: the one rule this app cannot fully meet

The production checklist opens with **"Photos must be hotlinked to the original
image URL on Unsplash"**. This app does the opposite for the glasses: the server
downloads the original, crops, greyscales, dithers and re-encodes it, then sends
its own bytes.

There is no way around it. The display takes 4-bit greyscale pixels over BLE; it
cannot resolve a URL, and there is no image format it accepts that Unsplash
serves. Any device in this class has the same problem.

What is done about it:

- **The phone panel hotlinks properly.** It loads `urls.small` straight from
  `images.unsplash.com` in an `<img>`, so on the one surface where a URL is
  meaningful, the rule is met exactly. That is why `images.unsplash.com` is in
  the `network` whitelist alongside the assistant server.
- **Everything else on the checklist is met**: the download endpoint is
  triggered, the photographer and Unsplash are both credited with UTM links, the
  app carries no Unsplash branding and is not named like it.

For a Demo key — personal use, 50 requests an hour — none of this blocks
anything. **Before applying for production, say plainly in the application that
the glasses render a re-encoded greyscale version because the hardware cannot
display anything else, and that the phone surface hotlinks normally.** Better
they rule on it than discover it.

## Why the client cannot name a URL

`/api/photos/frame/:id` resolves the id against that user's cached feed. The
client never hands the server a URL to fetch.

That is deliberate. An endpoint that downloads whatever URL it is given is an
open proxy into whatever network the server sits in — internal services, cloud
metadata endpoints. Resolving ids server-side closes it by construction.

## On the glasses

```
y=0    ┌──────────────────────────────────────────────┐  header
       │ Photos                                  3/24 │
y=32   │            ┌────────────────────┐            │  image container
       │            │                    │            │  288x144, centred
       │            │   288 x 144, 4-bit │            │
y=176  │            └────────────────────┘            │
y=184  │ A quiet street in Lisbon                     │  caption + credit
       │ photo: Jane Doe / Unsplash                   │
       │ Swipe to browse                              │
       └──────────────────────────────────────────────┘
```

Image containers never receive events, so a full-bleed text container sits
behind the photo carrying `isEventCapture`. Because any container on a page that
sets `zOrderIndex` obliges every other one to set a unique value too, all four
declare theirs.

Swipe up or down moves through the feed; a tap advances it. The next and
previous frames are fetched over HTTP while the current one is displayed — that
part is fast and safe to run ahead. Only the BLE push is serialised, because the
SDK forbids overlapping image sends.

A rebuilt page clears every image container, so `Renderer.render` reports
whether it rebuilt and the caller re-pushes the pixels.

## Filling the whole display

One image container maxes out at 288x144 — half the canvas. Four containers
tile it exactly: (0,0), (288,0), (0,144), (288,144).

That costs four serial BLE pushes, so 2-8 seconds per photo instead of 0.5-2.
It is a trade, not an upgrade, and worth deciding on real hardware. Not
implemented yet.

## What this does not do

- No TikTok, and no feed from it. Their API posts content and reads your own
  profile; there is no public endpoint for a browsable feed, so there is nothing
  to filter down to photo posts.
- No Google Photos. The `photoslibrary.readonly` scope was removed in March
  2025; the Library API now sees only what the app itself created. The Picker
  API could work, at the cost of the user selecting photos each session.
