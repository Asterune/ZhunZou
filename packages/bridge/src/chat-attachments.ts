import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ChatAttachment, ChatMessage, ChatSession } from '@zhunzou/shared';

import type { HubApi } from './hub-client.js';

const EXTENSIONS: Record<ChatAttachment['mime'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface PreparedPrompt {
  text: string;
  /** Absolute paths written for this turn. */
  files: string[];
}

/**
 * Compose the text the CLI receives. Chat CLIs take a prompt string, not an
 * image argument, so images become absolute local paths the agent can read.
 */
export function buildChatPrompt(
  content: string,
  images: Array<{ name: string; path: string }>,
  failed: string[] = [],
): string {
  const lines: string[] = [];
  const trimmed = content.trim();
  if (trimmed) lines.push(trimmed);

  if (images.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('【用户上传的图片】');
    for (const image of images) {
      lines.push(`- ${image.path}`);
    }
    lines.push('请直接读取上面的本地图片文件来查看内容。');
  }

  if (failed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('【未能获取的图片】');
    for (const name of failed) {
      lines.push(`- ${name}（下载失败，无法查看）`);
    }
  }

  return lines.join('\n') || '(用户发送了一条空消息)';
}

/**
 * Download the message's images beside the runner's state and turn them into
 * a prompt. A failed download is reported to the agent instead of silently
 * pretending the message had no image.
 */
export async function prepareChatPrompt(
  client: HubApi,
  session: ChatSession,
  message: ChatMessage,
  options: { homeDir?: string } = {},
): Promise<PreparedPrompt> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return { text: message.content, files: [] };
  }

  const directory = join(
    options.homeDir ?? homedir(),
    '.zhunzou',
    'chat-uploads',
    String(session.id),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const images: Array<{ name: string; path: string }> = [];
  const failed: string[] = [];
  const files: string[] = [];

  try {
    for (const attachment of attachments) {
      try {
        const bytes = await client.downloadChatAttachment(
          session.id,
          message.id,
          attachment.id,
        );
        const path = join(
          directory,
          `${message.id}-${attachment.id}.${EXTENSIONS[attachment.mime] ?? 'bin'}`,
        );
        await writeFile(path, bytes, { mode: 0o600 });
        images.push({ name: attachment.name, path });
        files.push(path);
      } catch {
        failed.push(attachment.name);
      }
    }
  } catch (error) {
    await removeChatAttachmentFiles(files);
    throw error;
  }

  return {
    text: buildChatPrompt(message.content, images, failed),
    files,
  };
}

/**
 * The phone keeps the original; the runner only needs its copy while the CLI
 * is reading it. Best-effort: a missing file is already the desired state.
 */
export async function removeChatAttachmentFiles(
  files: string[],
): Promise<void> {
  await Promise.all(
    files.map((path) => rm(path, { force: true }).catch(() => undefined)),
  );
}
