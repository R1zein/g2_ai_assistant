import type { AgendaItem } from '@g2/shared';
import { createEvent, listEvents, type CalendarEvent } from '../../google/calendar.js';
import { formatInZone, relativeTime } from '../../util/time.js';
import { type AssistantTool, toolSpec, type ToolContext } from './types.js';

function toAgendaItem(event: CalendarEvent, bookingType?: AgendaItem['bookingType']): AgendaItem {
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    location: event.location,
    source: event.bookingId ? 'booking' : 'calendar',
    bookingType,
    calendarEventId: event.id,
    relative: relativeTime(new Date(event.start)),
  };
}

/** Compact rendering for the model — full ISO plus a local-time restatement. */
function describe(event: CalendarEvent, timeZone: string): Record<string, unknown> {
  return {
    id: event.id,
    calendarId: event.calendarId,
    title: event.title,
    startIso: event.start,
    localStart: formatInZone(event.start, timeZone),
    endIso: event.end,
    relative: relativeTime(new Date(event.start)),
    allDay: event.allDay,
    location: event.location,
    notes: event.description?.slice(0, 800),
    attendees: event.attendees?.slice(0, 10),
  };
}

const getAgenda: AssistantTool = {
  spec: toolSpec(
    'get_agenda',
    'List the user\'s upcoming calendar events across every calendar they have selected, ' +
      'including hotel/flight/restaurant bookings the assistant synced from email. ' +
      'Use this for "what is next", "what do I have today/tomorrow/this week".',
    {
      hours_ahead: {
        type: 'integer',
        description: 'How far forward to look, in hours. 24 = rest of today and tonight, 168 = a week.',
        minimum: 1,
        maximum: 8760,
      },
      hours_behind: {
        type: 'integer',
        description: 'How far back to include, in hours. Use 1-3 to catch an event already in progress.',
        minimum: 0,
        maximum: 168,
      },
      max_results: { type: 'integer', minimum: 1, maximum: 25 },
    },
    ['hours_ahead', 'hours_behind', 'max_results'],
  ),
  async handler(input, ctx) {
    const hoursAhead = Number(input.hours_ahead ?? 24);
    const hoursBehind = Number(input.hours_behind ?? 1);
    const maxResults = Number(input.max_results ?? 10);

    const events = await listEvents(ctx.auth, {
      timeMin: new Date(Date.now() - hoursBehind * 3_600_000),
      timeMax: new Date(Date.now() + hoursAhead * 3_600_000),
      maxResults,
    });

    const bookingsByEvent = new Map(
      ctx.store
        .listBookings(ctx.user.id)
        .filter((b) => b.calendarEventId)
        .map((b) => [b.calendarEventId!, b]),
    );

    return {
      summary: `Read calendar (${events.length} event${events.length === 1 ? '' : 's'})`,
      content: {
        timeZone: ctx.timeZone,
        events: events.map((e) => ({
          ...describe(e, ctx.timeZone),
          booking: bookingsByEvent.get(e.id)
            ? {
                type: bookingsByEvent.get(e.id)!.type,
                confirmationCode: bookingsByEvent.get(e.id)!.confirmationCode,
                vendor: bookingsByEvent.get(e.id)!.vendor,
              }
            : undefined,
        })),
      },
      items: events.map((e) => toAgendaItem(e, bookingsByEvent.get(e.id)?.type)),
    };
  },
};

const searchCalendar: AssistantTool = {
  spec: toolSpec(
    'search_calendar',
    'Full-text search over the user\'s calendars within an explicit date range. ' +
      'Use when the question names a thing ("when is my flight to Lisbon", "the dentist appointment") ' +
      'rather than a time window.',
    {
      query: { type: 'string', description: 'Words to match in the title, description or location.' },
      start_iso: {
        type: 'string',
        description: 'Start of the search window, ISO-8601. Use a past date to search history.',
      },
      end_iso: { type: 'string', description: 'End of the search window, ISO-8601.' },
      max_results: { type: 'integer', minimum: 1, maximum: 25 },
    },
    ['query', 'start_iso', 'end_iso', 'max_results'],
  ),
  async handler(input, ctx) {
    const start = new Date(String(input.start_iso));
    const end = new Date(String(input.end_iso));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return {
        summary: 'Calendar search rejected',
        content: 'start_iso and end_iso must both be valid ISO-8601 timestamps.',
        isError: true,
      };
    }

    const events = await listEvents(ctx.auth, {
      timeMin: start,
      timeMax: end,
      query: String(input.query ?? ''),
      maxResults: Number(input.max_results ?? 10),
    });

    return {
      summary: `Searched calendar for "${String(input.query ?? '')}" (${events.length} hit${
        events.length === 1 ? '' : 's'
      })`,
      content: { timeZone: ctx.timeZone, events: events.map((e) => describe(e, ctx.timeZone)) },
      items: events.map((e) => toAgendaItem(e)),
    };
  },
};

const createCalendarEvent: AssistantTool = {
  spec: toolSpec(
    'create_calendar_event',
    'Add an event to the user\'s primary calendar. Only call this when the user explicitly ' +
      'asks to schedule, book or add something. Never create an event to "remember" a fact — ' +
      'use schedule_reminder for that.',
    {
      title: { type: 'string' },
      start_iso: {
        type: 'string',
        description: 'Event start, ISO-8601 with an offset, e.g. 2026-09-14T18:30:00+02:00.',
      },
      end_iso: { type: 'string', description: 'Event end, ISO-8601. Empty string means "one hour".' },
      location: { type: 'string', description: 'Address or place name. Empty string if unknown.' },
      description: { type: 'string', description: 'Extra notes. Empty string if none.' },
    },
    ['title', 'start_iso', 'end_iso', 'location', 'description'],
  ),
  async handler(input, ctx) {
    const start = String(input.start_iso ?? '');
    if (Number.isNaN(new Date(start).getTime())) {
      return {
        summary: 'Event not created',
        content: 'start_iso must be a valid ISO-8601 timestamp.',
        isError: true,
      };
    }

    const end = String(input.end_iso ?? '');
    const event = await createEvent(ctx.auth, {
      title: String(input.title ?? 'Untitled'),
      start,
      end: end || undefined,
      timeZone: ctx.timeZone,
      location: String(input.location ?? '') || undefined,
      description: String(input.description ?? '') || undefined,
    });

    return {
      summary: `Created "${event.title}"`,
      content: { created: describe(event, ctx.timeZone) },
      items: [toAgendaItem(event)],
    };
  },
};

const listBookings: AssistantTool = {
  spec: toolSpec(
    'list_bookings',
    'List reservations the assistant extracted from the user\'s email (hotels, flights, trains, ' +
      'restaurants, car rentals, deliveries), with confirmation codes, addresses, prices and ' +
      'cancellation terms. Prefer this over get_agenda when the user asks for booking details.',
    {
      type: {
        type: 'string',
        description:
          'Filter by booking type, or "any" for all. One of: any, hotel, flight, train, bus, ' +
          'car_rental, restaurant, event, appointment, delivery, other.',
      },
      include_past: {
        type: 'boolean',
        description: 'Include bookings whose start time has already passed.',
      },
      max_results: { type: 'integer', minimum: 1, maximum: 25 },
    },
    ['type', 'include_past', 'max_results'],
  ),
  async handler(input, ctx) {
    const typeFilter = String(input.type ?? 'any');
    const includePast = Boolean(input.include_past);
    const now = Date.now();

    const bookings = ctx.store
      .listBookings(ctx.user.id)
      .filter((b) => typeFilter === 'any' || b.type === typeFilter)
      .filter((b) => includePast || new Date(b.end ?? b.start).getTime() >= now)
      .slice(0, Number(input.max_results ?? 10));

    return {
      summary: `Read ${bookings.length} saved booking${bookings.length === 1 ? '' : 's'}`,
      content: {
        timeZone: ctx.timeZone,
        bookings: bookings.map((b) => ({
          id: b.id,
          type: b.type,
          title: b.title,
          vendor: b.vendor,
          confirmationCode: b.confirmationCode,
          startIso: b.start,
          localStart: formatInZone(b.start, b.timeZone),
          endIso: b.end,
          relative: relativeTime(new Date(b.start)),
          timeZoneAssumed: b.timeZoneAssumed,
          location: b.location,
          origin: b.origin,
          destination: b.destination,
          travellers: b.travellers,
          price: b.price,
          cancellationPolicy: b.cancellationPolicy,
          notes: b.notes,
          sourceSubject: b.sourceSubject,
        })),
      },
      items: bookings.map((b) => ({
        id: b.id,
        title: b.title,
        start: b.start,
        end: b.end,
        allDay: false,
        location: b.location?.name ?? b.location?.address,
        source: 'booking' as const,
        bookingType: b.type,
        calendarEventId: b.calendarEventId,
        relative: relativeTime(new Date(b.start)),
      })),
    };
  },
};

export const calendarTools: AssistantTool[] = [
  getAgenda,
  searchCalendar,
  listBookings,
  createCalendarEvent,
];

export { toAgendaItem };
