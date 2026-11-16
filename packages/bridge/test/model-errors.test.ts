import { describe, expect, it } from 'vitest';

import {
  classifyModelFailure,
  modelSwitchMayHelp,
} from '../src/sanitizer/model-errors.js';

describe('classifyModelFailure', () => {
  it('reads the fault out of the sentence OpenCode prints when the free tier ends', () => {
    // Verbatim, because the ordering of the patterns is what decides that this
    // is a quota problem and not "connect a provider", which it also says.
    expect(
      classifyModelFailure(
        'Error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.',
      ),
    ).toBe('quota_exhausted');
  });

  it('names each fault the node can act on', () => {
    expect(classifyModelFailure('You have no credits remaining.')).toBe('quota_exhausted');
    expect(classifyModelFailure('Please connect a provider to continue')).toBe(
      'provider_not_configured',
    );
    expect(classifyModelFailure('Subscribe to OpenCode Go to keep going')).toBe(
      'subscription_required',
    );
    expect(classifyModelFailure('Authentication failed: invalid api key')).toBe('auth_failed');
    expect(classifyModelFailure('HTTP 429 Too Many Requests')).toBe('rate_limited');
  });

  it('leaves a code failure unclassified', () => {
    expect(
      classifyModelFailure('FAIL src/login.test.ts\n  Expected 200, received 400'),
    ).toBeUndefined();
    expect(
      classifyModelFailure('TypeError: Cannot read properties of undefined (reading "map")'),
    ).toBeUndefined();
    expect(classifyModelFailure('   ')).toBeUndefined();
  });

  it('does not read a number in the source as an HTTP status', () => {
    // The patterns are deliberately long: a bare 429 would match a line number,
    // a port, or a test fixture and mislabel a run that never failed on quota.
    expect(classifyModelFailure('at parse.js:4291:18')).toBeUndefined();
  });
});

describe('modelSwitchMayHelp', () => {
  it('only counts the faults another model can answer', () => {
    expect(modelSwitchMayHelp('quota_exhausted')).toBe(true);
    expect(modelSwitchMayHelp('provider_not_configured')).toBe(true);
    expect(modelSwitchMayHelp('subscription_required')).toBe(true);
    expect(modelSwitchMayHelp('rate_limited')).toBe(false);
    expect(modelSwitchMayHelp('auth_failed')).toBe(false);
    expect(modelSwitchMayHelp(undefined)).toBe(false);
  });
});
