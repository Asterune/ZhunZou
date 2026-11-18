import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../src/lib/markdown';

describe('renderMarkdown', () => {
  it('renders the Markdown agents actually write', () => {
    const html = renderMarkdown(
      '### 改动\n\n| 项 | 做法 |\n| --- | --- |\n| A | `code` |\n\n```ts\nconst x = 1;\n```',
    );

    expect(html).toContain('<h3>改动</h3>');
    expect(html).toContain('<table>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<pre><code class="language-ts">');
  });

  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src=x onerror=alert(1)>',
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses javascript: links', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');

    expect(html).not.toContain('href="javascript');
  });

  it('opens links in a new tab without window.opener', () => {
    const html = renderMarkdown('[docs](https://example.com)');

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps single newlines as line breaks', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br>');
  });
});
