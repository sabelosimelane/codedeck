/**
 * A step note read for display: the Markdown agents write, as blocks of headings, lists,
 * paragraphs and code. Only what notes use; anything else stays as the text it is.
 */

/** `code` and **bold** runs in one line of text. An unmatched marker is plain text. */
function inline(text) {
  const runs = [];
  const push = run => {
    const last = runs.at(-1);
    if (last && !last.code && !last.bold && !run.code && !run.bold) last.text += run.text;
    else if (run.text !== '') runs.push(run);
  };
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    push({ text: text.slice(from, match.index) });
    push(match[1] !== undefined ? { text: match[1], code: true } : { text: match[2], bold: true });
    from = match.index + match[0].length;
  }
  push({ text: text.slice(from) });
  return runs;
}

export function parseNote(note) {
  if (typeof note !== 'string') throw new TypeError('note must be a string');
  const blocks = [];
  let open = null; // the paragraph or list item that a following line continues
  let fence = null;
  for (const line of note.split('\n')) {
    if (fence !== null) {
      if (/^\s*```/.test(line)) { blocks.push({ type: 'code', text: fence.join('\n') }); fence = null; } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { fence = []; open = null; continue; }
    if (line.trim() === '') { open = null; continue; }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() }); open = null; continue; }
    const item = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      const last = blocks.at(-1);
      const list = last?.type === 'list' && last.ordered === ordered && open !== null ? last : { type: 'list', ordered, items: [] };
      if (list !== last) blocks.push(list);
      open = { text: item[3].trim() };
      list.items.push(open);
      continue;
    }
    if (open !== null) { open.text += ` ${line.trim()}`; continue; }
    open = { type: 'paragraph', text: line.trim() };
    blocks.push(open);
  }
  if (fence !== null) blocks.push({ type: 'code', text: fence.join('\n') });
  return blocks.map((block) => {
    if (block.type === 'list') return { type: 'list', ordered: block.ordered, items: block.items.map(entry => inline(entry.text)) };
    if (block.type === 'code') return block;
    return block.type === 'heading' ? { type: 'heading', level: block.level, inline: inline(block.text) } : { type: 'paragraph', inline: inline(block.text) };
  });
}
