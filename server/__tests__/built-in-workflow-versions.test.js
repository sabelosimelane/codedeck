import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_TEMPLATES } from '../../shared/workflow-templates.mjs';
import { definitionHash } from '../../shared/workflow-changes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'built-in-workflow-versions.json'), 'utf8'));

// Spec §4.3: changing a built-in is edit the template, bump `version`, update the
// fixture. This test fails when a definition changes without a version bump, or a
// version goes up without the fixture being updated.
describe('built-in workflow versions', () => {
  it('gives every shipped template an integer version of at least 1', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(Number.isInteger(template.version) && template.version >= 1, `${template.id} needs version >= 1`).toBe(true);
    }
  });

  it('records exactly the shipped templates with their version and canonical hash', () => {
    expect(Object.keys(fixture).sort()).toEqual(WORKFLOW_TEMPLATES.map(template => template.id).sort());
    for (const template of WORKFLOW_TEMPLATES) {
      expect(fixture[template.id].version).toBe(template.version);
      expect(fixture[template.id].hash).toBe(definitionHash(template));
    }
  });
});
