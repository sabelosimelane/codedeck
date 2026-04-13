import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from '../markdownPreview';

describe('renderMarkdownToHtml', () => {
  it('renders common markdown blocks and inline formatting', () => {
    const html = renderMarkdownToHtml([
      '# Title',
      '',
      'Some **bold** text, _emphasis_, and `code`.',
      '',
      '- one',
      '- two',
      '',
      '> quoted',
      '',
      '```js',
      'const x = 1 < 2;',
      '```',
    ].join('\n'));

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Some <strong>bold</strong> text, <em>emphasis</em>, and <code>code</code>.</p>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>');
  });

  it('escapes unsafe html while preserving http links', () => {
    const html = renderMarkdownToHtml('Click <script>alert(1)</script> [docs](https://example.com)');

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('<script>');
  });

  it('renders mermaid code blocks as div.mermaid', () => {
    const html = renderMarkdownToHtml([
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
    ].join('\n'));

    expect(html).toContain('<div class="mermaid">graph TD\n  A --&gt; B</div>');
  });
});
