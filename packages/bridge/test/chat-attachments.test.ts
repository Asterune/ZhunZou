import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatMessage, ChatSession } from '@zhunzou/shared';

import type { HubApi } from '../src/hub-client.js';
import {
  buildChatPrompt,
  prepareChatPrompt,
  removeChatAttachmentFiles,
} from '../src/chat-attachments.js';

const session: ChatSession = {
  id: '7',
  env: 'test-env',
  title: 'Screenshot',
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1,
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '11',
    sessionId: '7',
    role: 'user',
    content: '',
    status: 'RUNNING',
    origin: 'human',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zhunzou-bridge-chat-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('buildChatPrompt', () => {
  it('keeps ordinary messages untouched', () => {
    expect(buildChatPrompt('hello', [])).toBe('hello');
  });

  it('lists absolute image paths and asks the agent to read them', () => {
    const text = buildChatPrompt('what is wrong here?', [
      { name: 'a.png', path: '/tmp/a.png' },
      { name: 'b.png', path: '/tmp/b.png' },
    ]);
    expect(text).toContain('what is wrong here?');
    expect(text).toContain('- /tmp/a.png');
    expect(text).toContain('- /tmp/b.png');
    expect(text).toContain('请直接读取');
  });

  it('reports images that could not be downloaded', () => {
    const text = buildChatPrompt('', [], ['broken.png']);
    expect(text).toContain('未能获取的图片');
    expect(text).toContain('broken.png');
  });
});

describe('prepareChatPrompt', () => {
  it('downloads each image beside the runner state', async () => {
    const bytes = Buffer.from('fake-png');
    const client = {
      downloadChatAttachment: async (
        sessionId: string,
        messageId: string,
        attachmentId: string,
      ) => {
        expect([sessionId, messageId, attachmentId]).toEqual(['7', '11', 'a1']);
        return bytes;
      },
    } as unknown as HubApi;

    const prepared = await prepareChatPrompt(
      client,
      session,
      message({
        content: 'look',
        attachments: [
          { id: 'a1', name: 'shot.png', mime: 'image/png', size: bytes.length },
        ],
      }),
      { homeDir: home },
    );

    expect(prepared.files).toHaveLength(1);
    expect(prepared.files[0]).toBe(
      join(home, '.zhunzou', 'chat-uploads', '7', '11-a1.png'),
    );
    expect((await readFile(prepared.files[0])).toString()).toBe('fake-png');
    expect(prepared.text).toContain(prepared.files[0]);
  });

  it('keeps the turn going when one image fails', async () => {
    const client = {
      downloadChatAttachment: async () => {
        throw new Error('offline');
      },
    } as unknown as HubApi;

    const prepared = await prepareChatPrompt(
      client,
      session,
      message({
        content: 'still here',
        attachments: [
          { id: 'a1', name: 'shot.png', mime: 'image/png', size: 1 },
        ],
      }),
      { homeDir: home },
    );

    expect(prepared.files).toEqual([]);
    expect(prepared.text).toContain('still here');
    expect(prepared.text).toContain('shot.png');
    expect(prepared.text).toContain('下载失败');
  });
});

describe('removeChatAttachmentFiles', () => {
  it('deletes the runner copies after the turn', async () => {
    const file = join(home, 'used.png');
    await writeFile(file, 'x');
    await removeChatAttachmentFiles([file]);
    await expect(readFile(file)).rejects.toThrow();
    // Missing files are already the desired state.
    await expect(removeChatAttachmentFiles([file])).resolves.toBeUndefined();
  });
});
