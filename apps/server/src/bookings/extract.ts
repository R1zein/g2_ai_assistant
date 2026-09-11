import * as z from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BOOKING_TYPES, type Booking, type BookingType } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import type { MailMessage } from '../google/gmail.js';
import type Anthropic from '@anthropic-ai/sdk';
import { describeApiError } from '../ai/anthropic.js';
import { EXTRACTION_SYSTEM } from '../ai/prompts.js';
import { sha256 } from '../util/id.js';
import { nowIso, zonedLocalToInstant } from '../util/time.js';
import { truncate } from '../util/text.js';

const log = logger('bookings:extract');

/**
 * Flat, fully-required schema with empty-string sentinels.
 *
 * Structured outputs are most reliable when nothing is optional and nothing is
 * nested — the model always fills every field, and "unknown" is an explicit
 * empty value rather than a missing key.
 */
const ExtractionSchema = z.object({
  is_booking: z.boolean(),
  type: z.enum(BOOKING_TYPES),
  title: z.string(),
  vendor: z.string(),
  confirmation_code: z.string(),
  start: z.string(),
  end: z.string(),
  time_zone: z.string(),
  time_zone_assumed: z.boolean(),
  location_name: z.string(),
  location_address: z.string(),
  origin_name: z.string(),
  destination_name: z.string(),
  travellers: z.number(),
  price_amount: z.number(),
  price_currency: z.string(),
  notes: z.string(),
  cancellation_policy: z.string(),
  confidence: z.number(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

/** Below this we keep the record but never write it to the calendar. */
export const CALENDAR_CONFIDENCE_FLOOR = 0.6;
/** Below this we discard the extraction entirely. */
export const KEEP_CONFIDENCE_FLOOR = 0.4;

function buildUserMessage(message: MailMessage, fallbackZone: string): string {
  return [
    `Fallback timezone (use only when the email states none): ${fallbackZone}`,
    `Email received: ${message.receivedAt}`,
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    '',
    '--- body ---',
    message.body || message.snippet,
  ].join('\n');
}

/**
 * Runs the model over one email. Returns null when it is not a reservation.
 *
 * The client is passed in rather than resolved here: a sync pass runs this
 * hundreds of times and they all bill to the same account.
 */
export async function extractBooking(
  client: Anthropic,
  message: MailMessage,
  fallbackZone: string,
): Promise<Extraction | null> {
  const cfg = loadConfig();

  try {
    const response = await client.messages.parse({
      model: cfg.extractionModel,
      max_tokens: 4_000,
      output_config: {
        effort: cfg.extractionEffort,
        format: zodOutputFormat(ExtractionSchema),
      },
      system: [
        // One email per call, same instructions every time — worth caching.
        { type: 'text', text: EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: buildUserMessage(message, fallbackZone) }],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      log.warn(`extraction returned no parsable output for message ${message.id}`);
      return null;
    }
    if (!parsed.is_booking) return null;
    if (parsed.confidence < KEEP_CONFIDENCE_FLOOR) {
      log.debug(`dropping low-confidence extraction (${parsed.confidence}) for ${message.id}`);
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(`extraction failed for message ${message.id}: ${describeApiError(err)}`);
    return null;
  }
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Stable identity for a reservation, so re-reading the same mail is a no-op. */
export function bookingIdentity(
  userId: string,
  extraction: Extraction,
  message: MailMessage,
): string {
  const key = [
    userId,
    extraction.type,
    nonEmpty(extraction.confirmation_code) ?? message.id,
    extraction.start.slice(0, 16),
  ].join('|');
  return sha256(key).slice(0, 24);
}

/** Fields that, when unchanged, mean we can skip the Google Calendar write. */
export function contentHash(booking: Booking): string {
  return sha256(
    JSON.stringify([
      booking.type,
      booking.title,
      booking.start,
      booking.end ?? '',
      booking.timeZone,
      booking.location?.address ?? booking.location?.name ?? '',
      booking.confirmationCode ?? '',
      booking.vendor ?? '',
      booking.price?.amount ?? 0,
    ]),
  ).slice(0, 32);
}

export interface ToBookingResult {
  booking: Booking;
  /** False when the model was confident enough to keep but not to write. */
  calendarEligible: boolean;
}

/** Normalises an extraction into the shared `Booking` shape. */
export function toBooking(
  extraction: Extraction,
  message: MailMessage,
  userId: string,
  fallbackZone: string,
): ToBookingResult | null {
  const timeZone = nonEmpty(extraction.time_zone) ?? fallbackZone;
  const startInstant = zonedLocalToInstant(extraction.start, timeZone);

  if (!startInstant) {
    log.warn(`unusable start "${extraction.start}" on message ${message.id}`);
    return null;
  }

  const endInstant = nonEmpty(extraction.end)
    ? zonedLocalToInstant(extraction.end, timeZone)
    : null;

  const type: BookingType = (BOOKING_TYPES as readonly string[]).includes(extraction.type)
    ? extraction.type
    : 'other';

  const now = nowIso();
  const booking: Booking = {
    id: bookingIdentity(userId, extraction, message),
    type,
    title: truncate(nonEmpty(extraction.title) ?? nonEmpty(message.subject) ?? 'Reservation', 80),
    vendor: nonEmpty(extraction.vendor),
    confirmationCode: nonEmpty(extraction.confirmation_code),
    start: startInstant.toISOString(),
    end: endInstant && endInstant > startInstant ? endInstant.toISOString() : undefined,
    timeZone,
    timeZoneAssumed: extraction.time_zone_assumed || !nonEmpty(extraction.time_zone),
    location:
      nonEmpty(extraction.location_name) || nonEmpty(extraction.location_address)
        ? { name: nonEmpty(extraction.location_name), address: nonEmpty(extraction.location_address) }
        : undefined,
    origin: nonEmpty(extraction.origin_name) ? { name: extraction.origin_name.trim() } : undefined,
    destination: nonEmpty(extraction.destination_name)
      ? { name: extraction.destination_name.trim() }
      : undefined,
    travellers: extraction.travellers > 0 ? Math.round(extraction.travellers) : undefined,
    price:
      extraction.price_amount > 0 && nonEmpty(extraction.price_currency)
        ? { amount: extraction.price_amount, currency: extraction.price_currency.trim().toUpperCase() }
        : undefined,
    notes: nonEmpty(extraction.notes),
    cancellationPolicy: nonEmpty(extraction.cancellation_policy),
    sourceMessageId: message.id,
    sourceSubject: message.subject,
    sourceReceivedAt: message.receivedAt,
    confidence: Math.max(0, Math.min(1, extraction.confidence)),
    createdAt: now,
    updatedAt: now,
  };

  return { booking, calendarEligible: booking.confidence >= CALENDAR_CONFIDENCE_FLOOR };
}
