function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function renderInline(text) {
  let html = escapeHtml(text);

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (
    `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer noopener">${label}</a>`
  ));
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');

  return html;
}

function consumeList(lines, startIndex, type) {
  const matcher = type === 'ol'
    ? /^\s*\d+\.\s+(.*)$/
    : /^\s*[-*+]\s+(.*)$/;
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(matcher);
    if (!match) break;
    items.push(`<li>${renderInline(match[1].trim())}</li>`);
    index += 1;
  }

  return {
    index,
    html: `<${type}>${items.join('')}</${type}>`,
  };
}

function consumeQuote(lines, startIndex) {
  const quoted = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!/^\s*>/.test(line)) break;
    quoted.push(line.replace(/^\s*>\s?/, ''));
    index += 1;
  }

  return {
    index,
    html: `<blockquote>${renderMarkdownToHtml(quoted.join('\n'))}</blockquote>`,
  };
}

function consumeCodeFence(lines, startIndex) {
  const firstLine = lines[startIndex];
  const language = firstLine.slice(3).trim();
  const content = [];
  let index = startIndex + 1;

  while (index < lines.length && !/^```/.test(lines[index])) {
    content.push(lines[index]);
    index += 1;
  }

  if (index < lines.length) index += 1;

  if (language === 'mermaid') {
    return {
      index,
      html: `<div class="mermaid">${escapeHtml(content.join('\n'))}</div>`,
    };
  }

  const className = language ? ` class="language-${escapeAttribute(language)}"` : '';
  return {
    index,
    html: `<pre><code${className}>${escapeHtml(content.join('\n'))}</code></pre>`,
  };
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;

  const content = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '');

  const cells = [];
  let current = '';
  let escaped = false;

  for (const char of content) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (escaped) current += '\\';
  cells.push(current.trim());

  return cells;
}

function getTableAlignment(separatorCell) {
  const trimmed = separatorCell.trim();
  if (!/^:?-{3,}:?$/.test(trimmed)) return null;
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
  if (trimmed.endsWith(':')) return 'right';
  if (trimmed.startsWith(':')) return 'left';
  return null;
}

function consumeTable(lines, startIndex) {
  const headerCells = splitTableRow(lines[startIndex]);
  const separatorCells = splitTableRow(lines[startIndex + 1] || '');

  if (!headerCells || !separatorCells || headerCells.length !== separatorCells.length || headerCells.length === 0) {
    return null;
  }

  const validSeparator = separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  if (!validSeparator) return null;

  const alignments = separatorCells.map(getTableAlignment);

  const buildCell = (tag, content, alignment, options = {}) => {
    const style = alignment ? ` style="text-align:${alignment}"` : '';
    const dataLabel = options.dataLabel
      ? ` data-label="${escapeAttribute(options.dataLabel)}"`
      : '';
    const cellContent = content ? renderInline(content) : '&nbsp;';
    return `<${tag}${style}${dataLabel}>${cellContent}</${tag}>`;
  };

  const head = `<thead><tr>${headerCells.map((cell, index) => buildCell('th', cell, alignments[index])).join('')}</tr></thead>`;

  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || !trimmed.includes('|')) break;

    const rowCells = splitTableRow(lines[index]);
    if (!rowCells || rowCells.length !== headerCells.length) break;

    rows.push(`<tr>${rowCells.map((cell, cellIndex) => buildCell('td', cell, alignments[cellIndex], { dataLabel: headerCells[cellIndex] })).join('')}</tr>`);
    index += 1;
  }

  return {
    index,
    html: `<div class="markdown-table-wrap"><table>${head}<tbody>${rows.join('')}</tbody></table></div>`,
  };
}

export function renderMarkdownToHtml(markdown) {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const fence = consumeCodeFence(lines, index);
      blocks.push(fence.html);
      index = fence.index;
      continue;
    }

    const table = consumeTable(lines, index);
    if (table) {
      blocks.push(table.html);
      index = table.index;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      blocks.push(`<h${depth}>${renderInline(headingMatch[2].trim())}</h${depth}>`);
      index += 1;
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      blocks.push('<hr />');
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = consumeQuote(lines, index);
      blocks.push(quote.html);
      index = quote.index;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const list = consumeList(lines, index, 'ul');
      blocks.push(list.html);
      index = list.index;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const list = consumeList(lines, index, 'ol');
      blocks.push(list.html);
      index = list.index;
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const candidate = lines[index];
      const candidateTrimmed = candidate.trim();
      if (
        !candidateTrimmed ||
        /^```/.test(candidateTrimmed) ||
        /^\|?.*\|.*$/.test(candidateTrimmed) && consumeTable(lines, index) ||
        /^(#{1,6})\s+/.test(candidateTrimmed) ||
        /^([-*_])(?:\s*\1){2,}\s*$/.test(candidateTrimmed) ||
        /^\s*>/.test(candidate) ||
        /^\s*[-*+]\s+/.test(candidate) ||
        /^\s*\d+\.\s+/.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidateTrimmed);
      index += 1;
    }

    blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return blocks.join('\n');
}
