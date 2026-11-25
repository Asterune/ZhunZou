import {
  providerUsageMetersSchema,
  type ProviderUsage,
} from '@zhunzou/shared';

/**
 * Derive the allowance endpoint from an OpenAI-compatible base URL.
 *
 * OpenCode Go serves inference at `…/inference/go/openai/v1` and usage at
 * `…/inference/go/v1/usage`. Only opencode.ai is known here; any other
 * provider needs an explicit `PROVIDER_USAGE_URL`.
 */
export function deriveProviderUsageUrl(
  baseUrl: string | undefined,
): string | undefined {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base || !/opencode\.ai/i.test(base)) return undefined;

  const match = base.match(/^(.*)\/(?:openai|anthropic)\/v1$/);
  return match ? `${match[1]}/v1/usage` : undefined;
}

export interface ProviderUsageReaderOptions {
  url?: string;
  apiKey?: string;
  /** Label shown on the card, e.g. `opencode-go`. */
  provider?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Reads the provider's allowance meters, cached briefly so a dashboard poll
 * cannot turn into a stream of upstream requests.
 */
export class ProviderUsageReader {
  private cache: { at: number; value: ProviderUsage } | null = null;

  constructor(private readonly options: ProviderUsageReaderOptions) {}

  async read(): Promise<ProviderUsage> {
    const now = this.options.now?.() ?? Date.now();
    const ttl = this.options.ttlMs ?? 60_000;
    if (this.cache && now - this.cache.at < ttl) return this.cache.value;

    const provider = this.options.provider ?? 'provider';
    const { url, apiKey } = this.options;
    if (!url || !apiKey) {
      return {
        provider,
        supported: false,
        usage: null,
        fetchedAt: now,
        error: '未配置额度查询接口或 Key',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const value: ProviderUsage = {
          provider,
          supported: false,
          usage: null,
          fetchedAt: now,
          error:
            response.status === 401 || response.status === 403
              ? '当前 Key 不支持额度查询'
              : `额度接口返回 ${response.status}`,
        };
        this.cache = { at: now, value };
        return value;
      }

      const body = (await response.json()) as { usage?: unknown };
      const parsed = providerUsageMetersSchema.safeParse(body?.usage);
      if (!parsed.success) {
        const value: ProviderUsage = {
          provider,
          supported: false,
          usage: null,
          fetchedAt: now,
          error: '额度接口返回格式异常',
        };
        this.cache = { at: now, value };
        return value;
      }

      const value: ProviderUsage = {
        provider,
        supported: true,
        usage: parsed.data,
        fetchedAt: now,
      };
      this.cache = { at: now, value };
      return value;
    } catch {
      // A transient failure must not be cached: the next poll should retry.
      return {
        provider,
        supported: false,
        usage: null,
        fetchedAt: now,
        error: '额度查询失败',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
