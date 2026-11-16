import { MODEL_SWITCH_MIGHT_HELP, type ModelFailureKind } from '@zhunzou/shared';

/**
 * Naming the reason a CLI refused to think.
 *
 * An agent that never started work fails the same way an agent that broke the
 * build does — exit code 1 — so the hub would send a "fix your code" diagnosis
 * at a machine that has no code to fix. These patterns read the CLI's own
 * complaint out of the tail it printed.
 *
 * The phrases are deliberately long. A bare `429` or `error` would match the
 * source a task is grepping, and a mislabelled fault costs the human more
 * trust than an unlabelled one.
 */
const PATTERNS: ReadonlyArray<{ kind: ModelFailureKind; test: RegExp }> = [
  {
    kind: 'quota_exhausted',
    test: /usage limit (?:reached|exceeded)|quota exceeded|credit balance(?: is)? too low|no credits remaining|out of (?:budget|credits)/i,
  },
  {
    kind: 'subscription_required',
    test: /subscribe to \S|subscription (?:required|expired)|upgrade (?:your|the) (?:plan|tier)|paid (?:plan|tier) (?:required|needed)/i,
  },
  {
    kind: 'provider_not_configured',
    test: /connect a provider|no provider (?:configured|set)|provider is not (?:configured|set up)|set up an? (?:api key|provider)/i,
  },
  {
    kind: 'auth_failed',
    test: /(?:invalid|expired|missing) (?:api[- ]key|token|credentials)|unauthorized\b|(?:http|status|error code|code)\s*:?\s*(?:401|403)\b|authentication (?:failed|required)|not logged in/i,
  },
  {
    kind: 'rate_limited',
    test: /rate limit(?:ed|ing)?\b|too many requests|(?:http|status|error code|code)\s*:?\s*429\b|429\s*(?:too many|rate)|overloaded[_ -]?(?:error|retry)?|please try again (?:later|shortly)/i,
  },
];

/** What the CLI complained about, when the complaint is one of these five. */
export function classifyModelFailure(text: string): ModelFailureKind | undefined {
  if (!text.trim()) return undefined;
  for (const pattern of PATTERNS) {
    if (pattern.test.test(text)) return pattern.kind;
  }
  return undefined;
}

/** The one judgement a node needs before it spends another run: would a different model answer this? */
export function modelSwitchMayHelp(kind: ModelFailureKind | undefined): boolean {
  if (!kind) return false;
  return MODEL_SWITCH_MIGHT_HELP.includes(kind);
}
