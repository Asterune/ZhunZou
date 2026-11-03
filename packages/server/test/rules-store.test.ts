import { describe, expect, it } from 'vitest';

import { appendRuleBlock } from '../src/rules-store.js';

describe('appendRuleBlock', () => {
  it('creates the section for an empty file', () => {
    expect(appendRuleBlock('', '- 一律使用 Pinia')).toBe(
      '## 历史批复沉淀\n\n- 一律使用 Pinia\n',
    );
  });

  it('appends to an existing generated section', () => {
    const current = '# 规则\n\n## 历史批复沉淀\n\n- 已有规则\n';
    const next = appendRuleBlock(current, '- 新规则');

    expect(next).toContain('- 已有规则');
    expect(next).toContain('- 新规则');
    expect(next.indexOf('- 新规则')).toBeGreaterThan(next.indexOf('- 已有规则'));
  });

  it('keeps the generated section before later hand-written sections', () => {
    const current = [
      '# 规则',
      '',
      '## 历史批复沉淀',
      '',
      '- 已有规则',
      '',
      '## 人工补充',
      '',
      '1. 不要删除数据。',
      '',
    ].join('\n');

    const next = appendRuleBlock(current, '- 新规则');

    expect(next.indexOf('- 新规则')).toBeLessThan(next.indexOf('## 人工补充'));
    expect(next).toContain('1. 不要删除数据。');
  });

  it('does not add the same rule twice', () => {
    const once = appendRuleBlock('', '- 一律使用 Pinia');
    expect(appendRuleBlock(once, '- 一律使用 Pinia')).toBe(once);
  });
});
