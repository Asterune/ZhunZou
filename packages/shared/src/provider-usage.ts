import { z } from 'zod';

/**
 * One allowance meter reported by a provider.
 *
 * OpenCode Go exposes three: the 5-hour rolling window, the week (resets
 * Monday 00:00 UTC) and the monthly allowance. `status` is `ok` or
 * `rate-limited`; other providers may add their own labels.
 */
export const providerUsageMeterSchema = z.object({
  status: z.string().trim().min(1).max(40),
  percent: z.number().min(0).max(100),
  /** ISO-8601 timestamp, kept verbatim so the dashboard renders local time. */
  resetsAt: z.string().trim().min(1).max(40),
});

export const providerUsageMetersSchema = z.object({
  rolling: providerUsageMeterSchema,
  weekly: providerUsageMeterSchema,
  monthly: providerUsageMeterSchema,
});

export const providerUsageSchema = z.object({
  /** e.g. `opencode-go`; shown on the card. */
  provider: z.string().trim().max(60),
  /** False when the configured key/provider has no usage endpoint. */
  supported: z.boolean(),
  usage: providerUsageMetersSchema.nullable(),
  fetchedAt: z.number().int().nonnegative(),
  /** Short reason when `supported` is false or the last refresh failed. */
  error: z.string().trim().max(200).optional(),
});

export type ProviderUsageMeter = z.infer<typeof providerUsageMeterSchema>;
export type ProviderUsageMeters = z.infer<typeof providerUsageMetersSchema>;
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
