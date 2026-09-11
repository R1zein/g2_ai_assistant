# Interaction model

Every gesture works from the temple touchpad and from the R1 ring — the firmware
reports the same event set for both, distinguished only by `eventSource`.

| Gesture | Event | What happens |
|---|---|---|
| **Long press** | `sysEvent` type 9 | Opens the glasses mic and starts recording. The HUD switches to *Listening*. |
| **Release** | `sysEvent` type 10 | Closes the mic and sends the capture. Hard stop at 20 s. |
| **Single press** | `sysEvent` type 0 *(arrives as `undefined` — protobuf drops zero values)* | Context dependent: dismiss a notification, leave an answer, page the agenda. |
| **Double press** | `sysEvent` type 3 | `shutDownPageContainer(1)` — the OS exit dialog. Cleanup happens on the exit event, not here, so cancelling leaves the app usable. |
| **Swipe up / down** | `textEvent` type 1 / 2 | Previous / next page of a long answer or agenda. |
| **Contextual menu** | `menuItemClickEvent` | Ask · Agenda · Brief me · Web on/off · Scan mail · Account · Exit |

Note that taps on a text container arrive as `sysEvent`, not `textEvent` — only
scroll gestures fire `textEvent`. This is the single most common source of
event-handling bugs on this platform.

## Screens

**Agenda** — the default. Up to eight rows, time first, then a type marker for
anything that came from a reservation:

```
Next: in 2h 10m                                              84%

15:40  [F] LH992 Prague - Munich
18:20  [H] Hotel Astoria - check-in
tmrw 09:00  Standup
tmrw 13:30  [R] Lunch, Cafe Savoy

Hold to ask                                                  1/2
```

`[F]` flight · `[H]` hotel · `[T]` train · `[B]` bus · `[C]` car · `[R]` restaurant · `[D]` delivery

**Listening** — a growing dash bar while the mic is open.

**Answer** — the question in the header, the answer paginated to whole lines in
the body. Swipe to read on.

**Notification** — a reminder card that overlays whatever was showing. A tap
returns to the previous screen. It never interrupts an in-flight capture.

## Why the answers are short

The system prompt is explicit about the medium: one to three sentences, under
320 characters, lists of at most four items with the time first, plain text only.
A HUD is read while walking. The server also shapes the result afterwards —
markdown stripped, emoji removed (the firmware font has no coverage and silently
drops them), smart quotes flattened, hard cap at 700 characters.

## Two modes

The **Web on/off** menu entry switches between them, and the header carries a
`web` badge while the web is in play. The setting is per account and survives a
restart.

**Off (`fast`)** — your calendar, mail, bookings and location, plus whatever the
model already knows. Answers in a couple of seconds. When a question genuinely
needs live data, it answers with what is solid and adds a short "turn on web in
the menu and ask again".

**On (`deep`)** — the same, plus Anthropic's server-side web search and page
fetch. Slower and more expensive per question, but it can answer anything.

Answers that used the web get one extra page listing the hostnames consulted.
Full URLs stay on the phone panel, where they are tappable — a URL on a HUD wraps
across three lines and cannot be followed anyway.

## What the wearer can ask

The assistant reaches the calendar, the mailbox, the extracted reservations, the
phone's position, the weather, a geocoder and the clock, and it chains them:

- *"What's next?"* · *"What do I have tomorrow?"*
- *"When do I check in, and what's the address?"* — the booking record, not a
  mail search
- *"What's my confirmation number for the hotel?"*
- *"Which gate?"* — falls through to the mailbox when the booking has no gate
- *"Can I still make the 18:20 train?"* — position plus the booking
- *"Do I need a jacket where I'm going?"* — destination coordinates plus weather
- *"Remind me to check in for the flight at 18:00"*
- *"Book dinner in the calendar for Friday at 20:00"*

Ordinary questions work too, and do not touch your data at all — *"how do I say
'the bill, please' in Czech"*, *"how many grams in eight ounces"*, *"what does
this error mean"*. Those are answered straight from the model's own knowledge in
either mode. Anything that changes — a score, a price, a timetable, a flight
status — needs web mode on.

## Failure behaviour

- A tool that fails is reported in one clause and the answer continues with what
  is available, rather than stalling.
- Losing the session drops straight back into pairing instead of erroring.
- An unreachable server shows a message screen naming the reason; the menu still
  works.
- A capture with no audio silently returns to the previous screen — an
  accidental long press costs nothing.
