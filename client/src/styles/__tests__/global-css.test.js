import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const globalCss = readFileSync(resolve(__dirname, '../global.css'), 'utf8');

function getRuleBody(selector) {
  const selectorStart = globalCss.indexOf(`${selector} {`);
  if (selectorStart === -1) return '';
  const bodyStart = globalCss.indexOf('{', selectorStart);
  const bodyEnd = globalCss.indexOf('}', bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) return '';
  return globalCss.slice(bodyStart + 1, bodyEnd);
}

describe('global project menu styles', () => {
  it('uses an opaque surface so project rows cannot bleed through the actions menu', () => {
    const projectMenuRule = getRuleBody('.project-menu');

    expect(projectMenuRule).toContain('background: var(--bg-surface);');
    expect(projectMenuRule).not.toContain('background: var(--bg-elevated);');
  });
});
