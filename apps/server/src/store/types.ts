import type { AssistantMode, AssistantNotification, Booking } from '@g2/shared';

export interface GoogleTokens {
  accessToken?: string;
  refreshToken: string;
  /** Epoch ms. */
  expiryDate?: number;
  scopes: string[];
}

export interface UserRecord {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  timeZone: string;
  tokens: GoogleTokens;
  /** Calendar the assistant writes extracted bookings into. */
  bookingsCalendarId?: string;
  /** Gmail `historyId` watermark for incremental sync. */
  gmailHistoryId?: string;
  lastGmailSyncAt?: string;
  /** Preferred answer language as a BCP-47 tag; empty means "match the question". */
  language?: string;
  /** Default mode for new questions from this account. */
  mode?: AssistantMode;
  /**
   * The account's own Anthropic key, sealed with `util/crypto`. Never stored or
   * logged in plaintext, and never returned over the API.
   */
  apiKeyCipher?: string;
  /** Last four characters, so the owner can tell which key is on file. */
  apiKeyHint?: string;
  apiKeySetAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRecord {
  deviceId: string;
  userId: string;
  /** We only ever persist the hash of the bearer token. */
  tokenHash: string;
  label?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface PairingRecord {
  code: string;
  deviceId: string;
  label?: string;
  status: 'pending' | 'linked' | 'expired';
  userId?: string;
  /** Handed to the device exactly once, on the poll that observes `linked`. */
  pendingToken?: string;
  createdAt: string;
  expiresAt: string;
}

export interface BookingRecord extends Booking {
  userId: string;
  /** Hash of the normalised booking fields; lets us skip no-op calendar writes. */
  contentHash: string;
}

export interface NotificationRecord extends AssistantNotification {
  userId: string;
  /** When this should fire. Past-dated entries are delivered on the next tick. */
  scheduledFor: string;
  deliveredAt?: string;
  /** Dedupe key so a restart does not re-send the same reminder. */
  dedupeKey: string;
}

/** One assistant thread. Stored as opaque JSON so SDK block types round-trip. */
export interface ConversationRecord {
  id: string;
  userId: string;
  /** `Anthropic.Beta.BetaMessageParam[]` — kept untyped to avoid a store->SDK dep. */
  messages: unknown[];
  updatedAt: string;
}

export interface Database {
  version: number;
  users: Record<string, UserRecord>;
  devices: Record<string, DeviceRecord>;
  pairings: Record<string, PairingRecord>;
  bookings: Record<string, BookingRecord>;
  notifications: Record<string, NotificationRecord>;
  conversations: Record<string, ConversationRecord>;
  /** Gmail message ids already examined, per user: `${userId}:${messageId}`. */
  seenMessages: Record<string, string>;
}

export function emptyDatabase(): Database {
  return {
    version: 1,
    users: {},
    devices: {},
    pairings: {},
    bookings: {},
    notifications: {},
    conversations: {},
    seenMessages: {},
  };
}
