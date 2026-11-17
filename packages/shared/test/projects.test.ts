import { describe, expect, it } from 'vitest';

import {
  canonicalProjectName,
  dedupeProjectNames,
  projectDisplayName,
  projectKey,
} from '../src/projects.js';

describe('projectKey', () => {
  it('folds case, inner whitespace and trailing separators', () => {
    const key = projectKey('  FitAI- ');
    expect(key).toBe('fitai');
    expect(projectKey('FitAI')).toBe(key);
    expect(projectKey('fitai')).toBe(key);
    expect(projectKey('Fit  AI.')).toBe('fit ai');
  });

  it('keeps meaningful inner punctuation', () => {
    expect(projectKey('my.app')).toBe('my.app');
    expect(projectKey('agent_hub')).toBe('agent_hub');
  });

  it('treats separator-only names as unknown', () => {
    expect(projectKey(' --- ')).toBe('');
    expect(projectKey('')).toBe('');
  });
});

describe('projectDisplayName', () => {
  it('trims and collapses whitespace without changing case', () => {
    expect(projectDisplayName('  FitAI- ')).toBe('FitAI-');
    expect(projectDisplayName('My   Project')).toBe('My Project');
  });
});

describe('canonicalProjectName', () => {
  it('reuses the first existing spelling', () => {
    expect(
      canonicalProjectName('fitai', ['FitAI-', 'FitAI', 'fitai']),
    ).toBe('FitAI-');
  });

  it('keeps the cleaned input when nothing matches', () => {
    expect(canonicalProjectName(' agent-hub ', ['FitAI-'])).toBe('agent-hub');
  });

  it('falls back to the cleaned input for a separator-only name', () => {
    expect(canonicalProjectName(' -- ', [])).toBe('--');
  });
});

describe('dedupeProjectNames', () => {
  it('keeps one entry per key in first-seen order', () => {
    expect(
      dedupeProjectNames([
        'FitAI-',
        'agent-hub',
        'FitAI',
        'fitai',
        'Agent-Hub',
        ' ',
      ]),
    ).toEqual(['FitAI-', 'agent-hub']);
  });

  it('applies the same key to names from different sources', () => {
    expect(dedupeProjectNames(['zhunzou', 'Zhunzou'])).toEqual(['zhunzou']);
  });
});
