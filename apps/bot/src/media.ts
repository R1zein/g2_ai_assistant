import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from 'grammy/types';

export interface MediaRef {
  kind: string;
  fileId: string;
  mime: string;
}

/** Pull the first downloadable attachment out of a message, if any. */
export function extractMedia(msg: Message): MediaRef | null {
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]!;
    return { kind: 'photo', fileId: best.file_id, mime: 'image/jpeg' };
  }
  if (msg.video) return { kind: 'video', fileId: msg.video.file_id, mime: msg.video.mime_type ?? 'video/mp4' };
  if (msg.video_note) return { kind: 'video_note', fileId: msg.video_note.file_id, mime: 'video/mp4' };
  if (msg.voice) return { kind: 'voice', fileId: msg.voice.file_id, mime: msg.voice.mime_type ?? 'audio/ogg' };
  if (msg.audio) return { kind: 'audio', fileId: msg.audio.file_id, mime: msg.audio.mime_type ?? 'audio/mpeg' };
  if (msg.animation) return { kind: 'animation', fileId: msg.animation.file_id, mime: msg.animation.mime_type ?? 'video/mp4' };
  if (msg.sticker) return { kind: 'sticker', fileId: msg.sticker.file_id, mime: 'image/webp' };
  if (msg.document) {
    return { kind: 'document', fileId: msg.document.file_id, mime: msg.document.mime_type ?? 'application/octet-stream' };
  }
  return null;
}

/**
 * Download a file the bot was given to the media directory and return
 * `{ id, file }` where `file` is the basename stored under that directory.
 *
 * The bot can only fetch files that were sent to it (or to a chat it is in):
 * the Bot API refuses `getFile` for anything else, and never delivers
 * view-once or self-destructing media at all.
 */
export async function downloadFile(
  token: string,
  filePath: string,
  mediaDir: string,
): Promise<{ id: string; file: string }> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const id = randomUUID();
  const ext = path.extname(filePath) || '.bin';
  const file = `${id}${ext}`;
  await writeFile(path.join(mediaDir, file), buf);
  return { id, file };
}
