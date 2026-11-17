import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChatImageError,
  readChatImage,
  saveChatImages,
  sniffImageMime,
} from '../src/chat-uploads.js';

/** A 1×1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhunzou-chat-uploads-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sniffImageMime', () => {
  it('recognises the formats chat accepts', () => {
    expect(sniffImageMime(Buffer.from(PNG_BASE64, 'base64'))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe(
      'image/jpeg',
    );
    expect(sniffImageMime(Buffer.from('GIF89a....', 'ascii'))).toBe('image/gif');
    expect(
      sniffImageMime(Buffer.from('RIFF0000WEBP....', 'ascii')),
    ).toBe('image/webp');
  });

  it('rejects anything else', () => {
    expect(sniffImageMime(Buffer.from('<svg></svg>'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('saveChatImages', () => {
  it('writes the bytes and returns addressable metadata', async () => {
    const saved = await saveChatImages(root, 7, [
      { name: 'screen shot.png', mime: 'image/png', data: PNG_BASE64 },
    ]);

    expect(saved.attachments).toHaveLength(1);
    const [attachment] = saved.attachments;
    expect(attachment).toMatchObject({
      name: 'screen shot.png',
      mime: 'image/png',
      size: Buffer.from(PNG_BASE64, 'base64').length,
    });
    expect(attachment.file).toMatch(/^[a-f0-9-]+\.png$/);

    const bytes = await readImageFile(7, attachment.file);
    expect(bytes.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);

    const fetched = await readChatImage(root, 7, attachment);
    expect(fetched?.equals(bytes)).toBe(true);
  });

  it('rejects a declared type that disagrees with the bytes', async () => {
    await expect(
      saveChatImages(root, 7, [
        { name: 'fake.png', mime: 'image/png', data: '/9j/4AAQ' },
      ]),
    ).rejects.toBeInstanceOf(ChatImageError);
  });

  it('rejects invalid base64', async () => {
    await expect(
      saveChatImages(root, 7, [
        { name: 'bad.png', mime: 'image/png', data: 'not base64 ***' },
      ]),
    ).rejects.toBeInstanceOf(ChatImageError);
  });

  it('accepts a data URL prefix for convenience', async () => {
    const saved = await saveChatImages(root, 7, [
      {
        name: 'inline.png',
        mime: 'image/png',
        data: `data:image/png;base64,${PNG_BASE64}`,
      },
    ]);
    expect(saved.attachments).toHaveLength(1);
  });
});

async function readImageFile(sessionId: number, file: string): Promise<Buffer> {
  return readFile(join(root, String(sessionId), file));
}
