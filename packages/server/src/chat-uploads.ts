import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  CHAT_MAX_IMAGE_BYTES,
  type ChatImageMime,
  type ChatImageUpload,
} from '@zhunzou/shared';

import type { StoredChatAttachment } from './db/schema.js';

const EXTENSIONS: Record<ChatImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};


export class ChatImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatImageError';
  }
}

/** Match the magic bytes, not the (attacker-controlled) declared type. */
export function sniffImageMime(buffer: Buffer): ChatImageMime | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function decodeBase64(data: string): Buffer {
  const payload = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const compact = payload.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new ChatImageError('image data is not valid base64');
  }
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length === 0) {
    throw new ChatImageError('image data is empty');
  }
  if (buffer.length > CHAT_MAX_IMAGE_BYTES) {
    throw new ChatImageError(
      `image is larger than ${Math.round(CHAT_MAX_IMAGE_BYTES / 1024 / 1024)} MB`,
    );
  }
  return buffer;
}

function safeName(name: string): string {
  const trimmed = basename(name).replace(/[\u0000-\u001f\u007f]/g, '');
  return (trimmed || 'image').slice(0, 200);
}

export interface SavedChatImages {
  attachments: StoredChatAttachment[];
  /** Absolute paths written, so a failed DB insert can clean them up. */
  files: string[];
}

/**
 * Decode, validate and store one message's images.
 *
 * The caller writes the message row only after this succeeds; if the insert
 * then fails, `removeChatImages` drops the files again.
 */
export async function saveChatImages(
  uploadsPath: string,
  sessionId: number,
  images: ChatImageUpload[],
): Promise<SavedChatImages> {
  const directory = join(uploadsPath, String(sessionId));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const attachments: StoredChatAttachment[] = [];
  const files: string[] = [];
  try {
    for (const image of images) {
      const buffer = decodeBase64(image.data);
      const sniffed = sniffImageMime(buffer);
      if (!sniffed) {
        throw new ChatImageError('only PNG, JPEG, WebP and GIF images are accepted');
      }
      if (sniffed !== image.mime) {
        throw new ChatImageError(
          `image type ${image.mime} does not match its contents`,
        );
      }

      const id = randomUUID();
      const file = `${id}.${EXTENSIONS[sniffed]}`;
      const path = join(directory, file);
      await writeFile(path, buffer, { mode: 0o600 });
      files.push(path);
      attachments.push({
        id,
        name: safeName(image.name),
        mime: sniffed,
        size: buffer.length,
        file,
      });
    }
  } catch (error) {
    await removeChatImages(uploadsPath, sessionId, attachments);
    throw error;
  }

  return { attachments, files };
}

/** Best-effort cleanup for a failed send or a deleted session. */
export async function removeChatImages(
  uploadsPath: string,
  sessionId: number,
  attachments: StoredChatAttachment[],
): Promise<void> {
  const directory = join(uploadsPath, String(sessionId));
  await Promise.all(
    attachments.map((attachment) =>
      unlink(join(directory, attachment.file)).catch(() => undefined),
    ),
  );
}

/** Remove a whole session's directory (session deletion). */
export async function removeSessionChatImages(
  uploadsPath: string,
  sessionId: number,
): Promise<void> {
  await rm(join(uploadsPath, String(sessionId)), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

/** Read one attachment's bytes; null when the file vanished. */
export async function readChatImage(
  uploadsPath: string,
  sessionId: number,
  attachment: StoredChatAttachment,
): Promise<Buffer | null> {
  try {
    return await readFile(join(uploadsPath, String(sessionId), attachment.file));
  } catch {
    return null;
  }
}
