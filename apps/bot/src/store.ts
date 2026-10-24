import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

const log = logger('store');

export interface ChatConfig {
  chatId: number;
  title: string;
  type: string;
  /** Whether the bot acts in this chat at all. */
  enabled: boolean;
  /** Repost a diff when someone edits a message. */
  trackEdits: boolean;
  addedBy: number;
  addedAt: number;
}

export interface MuteRecord {
  chatId: number;
  userId: number;
  userName: string;
  mutedBy: number;
  since: number;
}

export interface EditRecord {
  chatId: number;
  chatTitle: string;
  messageId: number;
  userId: number;
  userName: string;
  before: string;
  after: string;
  at: number;
}

export interface MediaRecord {
  id: string;
  chatId: number;
  chatTitle: string;
  fromId: number;
  fromName: string;
  kind: string;
  file: string;
  mime: string;
  caption: string;
  savedBy: number;
  at: number;
}

export interface BizConnection {
  id: string;
  /** Private chat with the owner who connected the bot to their account. */
  userChatId: number;
  ownerName: string;
  canReadMessages: boolean;
  canDelete: boolean;
  isEnabled: boolean;
  at: number;
}

/** A per-peer "mute" in the owner's own DMs: incoming messages get deleted. */
export interface BizMute {
  connectionId: string;
  peerChatId: number;
  peerName: string;
  since: number;
}

export interface BizCapture {
  connectionId: string;
  kind: 'deleted' | 'edited';
  peerChatId: number;
  peerName: string;
  text: string;
  before?: string;
  at: number;
}

interface Db {
  chats: Record<string, ChatConfig>;
  mutes: MuteRecord[];
  edits: EditRecord[];
  media: MediaRecord[];
  bizConnections: Record<string, BizConnection>;
  bizMutes: BizMute[];
  bizCaptures: BizCapture[];
}

function empty(): Db {
  return {
    chats: {},
    mutes: [],
    edits: [],
    media: [],
    bizConnections: {},
    bizMutes: [],
    bizCaptures: [],
  };
}

/**
 * Durable JSON store for the bot. Same shape as the server's store: one file,
 * atomic rename on write, debounced. Media blobs live on disk under
 * `<dataDir>/media`; only an index row lives here.
 */
export class BotStore {
  private db: Db = empty();
  private readonly file: string;
  private readonly mediaDir: string;
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly dir: string,
    private readonly editLogLimit: number,
  ) {
    this.file = path.join(dir, 'db.json');
    this.mediaDir = path.join(dir, 'media');
  }

  static async open(dir: string, editLogLimit: number): Promise<BotStore> {
    const store = new BotStore(dir, editLogLimit);
    await mkdir(store.mediaDir, { recursive: true });
    try {
      const raw = await readFile(store.file, 'utf8');
      store.db = { ...empty(), ...(JSON.parse(raw) as Partial<Db>) };
      log.info(
        `loaded ${Object.keys(store.db.chats).length} chat(s), ` +
          `${store.db.mutes.length} mute(s), ${store.db.media.length} media`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info(`no database at ${store.file} — starting empty`);
        await store.flush();
      } else {
        throw err;
      }
    }
    return store;
  }

  get mediaDirectory(): string {
    return this.mediaDir;
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((err) => log.error('flush failed', err));
    }, 250);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.db, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  // --- chats ---------------------------------------------------------------

  listChats(): ChatConfig[] {
    return Object.values(this.db.chats);
  }

  getChat(chatId: number): ChatConfig | undefined {
    return this.db.chats[String(chatId)];
  }

  /** Create the row on first contact; never flips an existing toggle. */
  ensureChat(chatId: number, title: string, type: string, addedBy: number): ChatConfig {
    const key = String(chatId);
    let chat = this.db.chats[key];
    if (!chat) {
      chat = {
        chatId,
        title,
        type,
        enabled: true,
        trackEdits: true,
        addedBy,
        addedAt: Date.now(),
      };
      this.db.chats[key] = chat;
      this.save();
    } else if (chat.title !== title || chat.type !== type) {
      chat.title = title;
      chat.type = type;
      this.save();
    }
    return chat;
  }

  setChatFlag(chatId: number, flag: 'enabled' | 'trackEdits', value: boolean): void {
    const chat = this.db.chats[String(chatId)];
    if (!chat) return;
    chat[flag] = value;
    this.save();
  }

  // --- mutes ---------------------------------------------------------------

  isMuted(chatId: number, userId: number): boolean {
    return this.db.mutes.some((m) => m.chatId === chatId && m.userId === userId);
  }

  listMutes(): MuteRecord[] {
    return this.db.mutes.slice();
  }

  addMute(record: MuteRecord): void {
    if (this.isMuted(record.chatId, record.userId)) return;
    this.db.mutes.push(record);
    this.save();
  }

  removeMute(chatId: number, userId: number): boolean {
    const before = this.db.mutes.length;
    this.db.mutes = this.db.mutes.filter((m) => !(m.chatId === chatId && m.userId === userId));
    const changed = this.db.mutes.length !== before;
    if (changed) this.save();
    return changed;
  }

  // --- edits ---------------------------------------------------------------

  addEdit(record: EditRecord): void {
    this.db.edits.push(record);
    // Ring buffer: trim per chat so one busy chat can't starve the rest.
    const forChat = this.db.edits.filter((e) => e.chatId === record.chatId);
    if (forChat.length > this.editLogLimit) {
      const drop = new Set(forChat.slice(0, forChat.length - this.editLogLimit));
      this.db.edits = this.db.edits.filter((e) => !drop.has(e));
    }
    this.save();
  }

  listEdits(limit = 100): EditRecord[] {
    return this.db.edits.slice(-limit).reverse();
  }

  // --- media ---------------------------------------------------------------

  addMedia(record: MediaRecord): void {
    this.db.media.push(record);
    this.save();
  }

  listMedia(limit = 100): MediaRecord[] {
    return this.db.media.slice(-limit).reverse();
  }

  getMedia(id: string): MediaRecord | undefined {
    return this.db.media.find((m) => m.id === id);
  }

  // --- business connections -----------------------------------------------

  upsertBizConnection(conn: BizConnection): void {
    this.db.bizConnections[conn.id] = conn;
    this.save();
  }

  getBizConnection(id: string): BizConnection | undefined {
    return this.db.bizConnections[id];
  }

  listBizConnections(): BizConnection[] {
    return Object.values(this.db.bizConnections);
  }

  isBizMuted(connectionId: string, peerChatId: number): boolean {
    return this.db.bizMutes.some(
      (m) => m.connectionId === connectionId && m.peerChatId === peerChatId,
    );
  }

  listBizMutes(): BizMute[] {
    return this.db.bizMutes.slice();
  }

  addBizMute(record: BizMute): void {
    if (this.isBizMuted(record.connectionId, record.peerChatId)) return;
    this.db.bizMutes.push(record);
    this.save();
  }

  removeBizMute(connectionId: string, peerChatId: number): boolean {
    const before = this.db.bizMutes.length;
    this.db.bizMutes = this.db.bizMutes.filter(
      (m) => !(m.connectionId === connectionId && m.peerChatId === peerChatId),
    );
    const changed = this.db.bizMutes.length !== before;
    if (changed) this.save();
    return changed;
  }

  addBizCapture(record: BizCapture): void {
    this.db.bizCaptures.push(record);
    if (this.db.bizCaptures.length > this.editLogLimit * 4) {
      this.db.bizCaptures = this.db.bizCaptures.slice(-this.editLogLimit * 4);
    }
    this.save();
  }

  listBizCaptures(limit = 100): BizCapture[] {
    return this.db.bizCaptures.slice(-limit).reverse();
  }
}
