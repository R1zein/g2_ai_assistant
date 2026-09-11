import { loadConfig } from '../config.js';
import { pairingCode, sessionToken, sha256, uuid } from '../util/id.js';
import { addDays, nowIso } from '../util/time.js';
import { JsonStore } from './jsonStore.js';
import type {
  BookingRecord,
  ConversationRecord,
  DeviceRecord,
  GoogleTokens,
  NotificationRecord,
  PairingRecord,
  UserRecord,
} from './types.js';

export * from './types.js';

/**
 * Application-level data access. Every read/write the rest of the server does
 * goes through here — no module touches the raw JSON document.
 */
export class Store {
  private constructor(private readonly backing: JsonStore) {}

  static async open(dir = loadConfig().dataDir): Promise<Store> {
    const backing = new JsonStore(dir);
    await backing.load();
    return new Store(backing);
  }

  close(): Promise<void> {
    return this.backing.close();
  }

  /* ---------------- users ---------------- */

  upsertUser(input: {
    email: string;
    name?: string;
    picture?: string;
    timeZone: string;
    tokens: GoogleTokens;
  }): UserRecord {
    const db = this.backing.data;
    const existing = Object.values(db.users).find((u) => u.email === input.email);
    const now = nowIso();

    if (existing) {
      existing.name = input.name ?? existing.name;
      existing.picture = input.picture ?? existing.picture;
      existing.timeZone = input.timeZone || existing.timeZone;
      existing.tokens = {
        ...existing.tokens,
        ...input.tokens,
        // Google only returns a refresh token on the first consent; never clobber it.
        refreshToken: input.tokens.refreshToken || existing.tokens.refreshToken,
      };
      existing.updatedAt = now;
      this.backing.save();
      return existing;
    }

    const user: UserRecord = {
      id: uuid(),
      email: input.email,
      name: input.name,
      picture: input.picture,
      timeZone: input.timeZone,
      tokens: input.tokens,
      createdAt: now,
      updatedAt: now,
    };
    db.users[user.id] = user;
    this.backing.save();
    return user;
  }

  getUser(userId: string): UserRecord | undefined {
    return this.backing.data.users[userId];
  }

  listUsers(): UserRecord[] {
    return Object.values(this.backing.data.users);
  }

  updateUser(userId: string, patch: Partial<UserRecord>): UserRecord | undefined {
    const user = this.backing.data.users[userId];
    if (!user) return undefined;
    Object.assign(user, patch, { updatedAt: nowIso() });
    this.backing.save();
    return user;
  }

  /* ---------------- pairing ---------------- */

  createPairing(deviceId: string, label?: string): PairingRecord {
    const cfg = loadConfig();
    const db = this.backing.data;

    // One live pairing per device: drop any previous pending attempt.
    for (const [code, rec] of Object.entries(db.pairings)) {
      if (rec.deviceId === deviceId && rec.status === 'pending') delete db.pairings[code];
    }

    const record: PairingRecord = {
      code: pairingCode(),
      deviceId,
      label,
      status: 'pending',
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + cfg.pairingTtlMinutes * 60_000).toISOString(),
    };
    db.pairings[record.code] = record;
    this.backing.save();
    return record;
  }

  getPairing(code: string): PairingRecord | undefined {
    const rec = this.backing.data.pairings[code.toUpperCase().trim()];
    if (!rec) return undefined;
    if (rec.status === 'pending' && new Date(rec.expiresAt).getTime() < Date.now()) {
      rec.status = 'expired';
      this.backing.save();
    }
    return rec;
  }

  /** Completes a pairing: binds the device to a user and mints a bearer token. */
  linkPairing(code: string, userId: string): PairingRecord | undefined {
    const rec = this.getPairing(code);
    if (!rec || rec.status !== 'pending') return undefined;

    const token = sessionToken();
    this.registerDevice(rec.deviceId, userId, token, rec.label);

    rec.status = 'linked';
    rec.userId = userId;
    rec.pendingToken = token;
    this.backing.save();
    return rec;
  }

  /** Hands the bearer token to the device exactly once, then forgets it. */
  claimPairingToken(code: string): string | undefined {
    const rec = this.getPairing(code);
    if (!rec || rec.status !== 'linked') return undefined;
    const token = rec.pendingToken;
    delete rec.pendingToken;
    this.backing.save();
    return token;
  }

  /* ---------------- devices / sessions ---------------- */

  registerDevice(deviceId: string, userId: string, token: string, label?: string): DeviceRecord {
    const cfg = loadConfig();
    const now = nowIso();
    const record: DeviceRecord = {
      deviceId,
      userId,
      tokenHash: sha256(token),
      label,
      createdAt: this.backing.data.devices[deviceId]?.createdAt ?? now,
      lastSeenAt: now,
      expiresAt: addDays(new Date(), cfg.sessionTtlDays).toISOString(),
    };
    this.backing.data.devices[deviceId] = record;
    this.backing.save();
    return record;
  }

  /** Resolves a bearer token to its device, or undefined when invalid/expired. */
  authenticate(token: string): { device: DeviceRecord; user: UserRecord } | undefined {
    if (!token) return undefined;
    const hash = sha256(token);
    const device = Object.values(this.backing.data.devices).find((d) => d.tokenHash === hash);
    if (!device) return undefined;
    if (new Date(device.expiresAt).getTime() < Date.now()) return undefined;
    const user = this.backing.data.users[device.userId];
    if (!user) return undefined;

    device.lastSeenAt = nowIso();
    this.backing.save();
    return { device, user };
  }

  revokeDevice(deviceId: string): void {
    delete this.backing.data.devices[deviceId];
    this.backing.save();
  }

  /* ---------------- bookings ---------------- */

  listBookings(userId: string): BookingRecord[] {
    return Object.values(this.backing.data.bookings)
      .filter((b) => b.userId === userId)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  getBooking(id: string): BookingRecord | undefined {
    return this.backing.data.bookings[id];
  }

  findBookingByMessage(userId: string, messageId: string): BookingRecord | undefined {
    return Object.values(this.backing.data.bookings).find(
      (b) => b.userId === userId && b.sourceMessageId === messageId,
    );
  }

  putBooking(record: BookingRecord): BookingRecord {
    this.backing.data.bookings[record.id] = record;
    this.backing.save();
    return record;
  }

  deleteBooking(id: string): void {
    delete this.backing.data.bookings[id];
    this.backing.save();
  }

  /* ---------------- gmail dedupe ---------------- */

  hasSeenMessage(userId: string, messageId: string): boolean {
    return `${userId}:${messageId}` in this.backing.data.seenMessages;
  }

  markMessageSeen(userId: string, messageId: string): void {
    this.backing.data.seenMessages[`${userId}:${messageId}`] = nowIso();
    this.backing.save();
  }

  /* ---------------- notifications ---------------- */

  listNotifications(userId: string, opts: { pendingOnly?: boolean } = {}): NotificationRecord[] {
    return Object.values(this.backing.data.notifications)
      .filter((n) => n.userId === userId && (!opts.pendingOnly || !n.deliveredAt))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  }

  /** Idempotent on `dedupeKey` so restarts never double-fire a reminder. */
  scheduleNotification(record: Omit<NotificationRecord, 'id' | 'createdAt'>): NotificationRecord | undefined {
    const db = this.backing.data;
    const duplicate = Object.values(db.notifications).find(
      (n) => n.userId === record.userId && n.dedupeKey === record.dedupeKey,
    );
    if (duplicate) return undefined;

    const full: NotificationRecord = { ...record, id: uuid(), createdAt: nowIso() };
    db.notifications[full.id] = full;
    this.backing.save();
    return full;
  }

  markNotificationDelivered(id: string): void {
    const rec = this.backing.data.notifications[id];
    if (!rec) return;
    rec.deliveredAt = nowIso();
    this.backing.save();
  }

  /** Drops delivered notifications older than `days` to keep the file small. */
  pruneNotifications(days = 14): void {
    const cutoff = Date.now() - days * 86_400_000;
    const db = this.backing.data;
    for (const [id, rec] of Object.entries(db.notifications)) {
      if (rec.deliveredAt && new Date(rec.deliveredAt).getTime() < cutoff) delete db.notifications[id];
    }
    this.backing.save();
  }

  /* ---------------- conversations ---------------- */

  getConversation(id: string, userId: string): ConversationRecord | undefined {
    const rec = this.backing.data.conversations[id];
    return rec && rec.userId === userId ? rec : undefined;
  }

  saveConversation(id: string, userId: string, messages: unknown[]): ConversationRecord {
    const rec: ConversationRecord = { id, userId, messages, updatedAt: nowIso() };
    this.backing.data.conversations[id] = rec;
    this.backing.save();
    return rec;
  }

  /** Conversations are short-lived HUD threads; keep a day of them at most. */
  pruneConversations(hours = 24): void {
    const cutoff = Date.now() - hours * 3_600_000;
    const db = this.backing.data;
    for (const [id, rec] of Object.entries(db.conversations)) {
      if (new Date(rec.updatedAt).getTime() < cutoff) delete db.conversations[id];
    }
    this.backing.save();
  }
}
