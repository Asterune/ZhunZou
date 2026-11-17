import type { ChatAttachment, ChatImageMime, ChatImageUpload } from '@zhunzou/shared';

import { hubApi } from './api';

const OBJECT_URL_CACHE_LIMIT = 24;
const objectUrls = new Map<string, string>();

function key(
  sessionId: string,
  messageId: string,
  attachmentId: string,
): string {
  return `${sessionId}:${messageId}:${attachmentId}`;
}

/** Read a picked file into the base64 payload the hub expects. */
export function readImageUpload(file: File): Promise<ChatImageUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('cannot read image'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (!result.startsWith('data:') || comma < 0) {
        reject(new Error('cannot read image'));
        return;
      }
      resolve({
        name: file.name || 'image',
        mime: (file.type || 'image/png') as ChatImageMime,
        data: result.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Drop a cached blob once the hub has discarded the file. The transcript then
 * renders the "used and cleared" placeholder instead of a stale image.
 */
export function releaseChatAttachmentUrl(
  sessionId: string,
  messageId: string,
  attachmentId: string,
): void {
  const cacheKey = key(sessionId, messageId, attachmentId);
  const url = objectUrls.get(cacheKey);
  if (!url) return;
  objectUrls.delete(cacheKey);
  URL.revokeObjectURL(url);
}

/**
 * Fetch an attachment once and keep a small LRU of object URLs, so scrolling
 * the transcript does not re-download every image or leak every blob.
 */
export async function chatAttachmentUrl(
  token: string,
  sessionId: string,
  messageId: string,
  attachment: ChatAttachment,
): Promise<string> {
  const cacheKey = key(sessionId, messageId, attachment.id);
  const cached = objectUrls.get(cacheKey);
  if (cached) {
    // Refresh its position in the insertion-ordered map.
    objectUrls.delete(cacheKey);
    objectUrls.set(cacheKey, cached);
    return cached;
  }

  const blob = await hubApi.getChatAttachmentBlob(
    token,
    sessionId,
    messageId,
    attachment.id,
  );
  const url = URL.createObjectURL(blob);
  objectUrls.set(cacheKey, url);

  while (objectUrls.size > OBJECT_URL_CACHE_LIMIT) {
    const oldest = objectUrls.keys().next().value as string | undefined;
    if (!oldest) break;
    const stale = objectUrls.get(oldest);
    objectUrls.delete(oldest);
    if (stale) URL.revokeObjectURL(stale);
  }
  return url;
}
