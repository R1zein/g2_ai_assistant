import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { type Database, emptyDatabase } from './types.js';

const log = logger('store');

/**
 * Durable JSON store.
 *
 * Deliberately dependency-free: one process, one file, atomic rename on write.
 * Everything goes through `Store`, so swapping in Postgres or SQLite later only
 * touches this file.
 */
export class JsonStore {
  private db: Database = emptyDatabase();
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, 'db.json');
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Database>;
      this.db = { ...emptyDatabase(), ...parsed };
      log.info(
        `loaded ${Object.keys(this.db.users).length} user(s), ` +
          `${Object.keys(this.db.bookings).length} booking(s)`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info(`no database at ${this.file} — starting empty`);
        await this.flush();
      } else {
        throw err;
      }
    }
  }

  /** Direct access to the in-memory document. Mutate, then call `save()`. */
  get data(): Database {
    return this.db;
  }

  /** Debounced persist. Safe to call on every mutation. */
  save(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 250);
    this.writeTimer.unref?.();
  }

  /** Force an immediate write and wait for it — used on shutdown. */
  async flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      this.dirty = false;
      const tmp = `${this.file}.tmp`;
      const payload = JSON.stringify(this.db, null, 2);
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.file);
    });
    await this.writing;
  }

  async close(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flush();
  }
}
