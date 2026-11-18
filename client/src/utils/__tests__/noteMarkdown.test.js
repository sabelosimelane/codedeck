import { describe, expect, it } from 'vitest';
import { parseNote } from '../noteMarkdown.js';

describe('reading a step note for display', () => {
  it('turns headings, lists, paragraphs and code fences into blocks', () => {
    const note = `# Analysis

Both voice calls build their words
from the whole stored name.

- \`watch/WakeFacts.java:45\` uses it once
  and once more via \`expectation()\`.
- **The spec asks for exactly this**, so the code is to spec.

1. Change two classes
2. Update the spec

\`\`\`java
String first = name.split(" ")[0];
\`\`\`
## Ruled out`;
    expect(parseNote(note)).toEqual([
      { type: 'heading', level: 1, inline: [{ text: 'Analysis' }] },
      { type: 'paragraph', inline: [{ text: 'Both voice calls build their words from the whole stored name.' }] },
      { type: 'list', ordered: false, items: [
        [{ text: 'watch/WakeFacts.java:45', code: true }, { text: ' uses it once and once more via ' }, { text: 'expectation()', code: true }, { text: '.' }],
        [{ text: 'The spec asks for exactly this', bold: true }, { text: ', so the code is to spec.' }],
      ] },
      { type: 'list', ordered: true, items: [[{ text: 'Change two classes' }], [{ text: 'Update the spec' }]] },
      { type: 'code', text: 'String first = name.split(" ")[0];' },
      { type: 'heading', level: 2, inline: [{ text: 'Ruled out' }] },
    ]);
  });

  it('keeps unmatched markers as plain text', () => {
    expect(parseNote('a ** b and a ` c')).toEqual([{ type: 'paragraph', inline: [{ text: 'a ** b and a ` c' }] }]);
  });

  it('refuses anything but text', () => {
    expect(() => parseNote(null)).toThrow('note must be a string');
    expect(parseNote('  \n')).toEqual([]);
  });
});
