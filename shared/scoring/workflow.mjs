import { count, createMetricRegistry, fraction, median, requireField, text } from './engine.mjs';

const always = () => true;
const counters = ['activeMs', 'launches', 'loops'];
const gap = (row) => row.flags.includes('proofGap');
const missingNote = (row) => !row.finalNote;

export const workflowPolicy = Object.freeze({
  subjectType: 'workflow',
  version: 1,
  prepare(row) {
    requireField(text(row.project), 'workflow observation.project');
    requireField(row.workload === null || text(row.workload), 'workflow observation.workload');
    requireField(
      ['complete', 'stopped', 'interrupted', 'error'].includes(row.status),
      'workflow observation.status',
    );
    requireField(row.activeMs === null || count(row.activeMs), 'workflow observation.activeMs');
    requireField(count(row.launches), 'workflow observation.launches');
    requireField(count(row.loops), 'workflow observation.loops');
    requireField(Array.isArray(row.flags) && row.flags.every(text), 'workflow observation.flags');
    requireField(typeof row.finalNote === 'boolean', 'workflow observation.finalNote');
    return row;
  },
  registry: createMetricRegistry([
    ...counters.map((id) => ({
      id,
      version: 1,
      unit: id === 'activeMs' ? 'ms' : 'count',
      direction: 'lower',
      eligible: always,
      aggregate: (rows) => median(rows.map((row) => row[id])),
    })),
    ...[
      ['proofGaps', gap],
      ['missingFinalNotes', missingNote],
    ].map(([id, matches]) => ({
      id,
      version: 1,
      unit: 'fraction',
      direction: 'lower',
      eligible: always,
      aggregate: (rows) => fraction(rows, matches),
    })),
  ]),
});

const WORKFLOW_COMPARE_MIN = 3;

// Preserve the workflow v1 comparison wire format, including unknown historical timings.
export function compareWorkflow(before, after, metric, safeguard) {
  const measure = (rows, key) => workflowPolicy.registry.measure(rows, key).value;
  const a = measure(before, metric);
  const b = measure(after, metric);
  const guardBefore = measure(before, safeguard);
  const guardAfter = measure(after, safeguard);
  let verdict = 'inconclusive';
  if (
    before.length >= WORKFLOW_COMPARE_MIN &&
    after.length >= WORKFLOW_COMPARE_MIN &&
    a !== null &&
    b !== null
  ) {
    if (guardAfter > guardBefore || b > a) verdict = 'regressed';
    else if (b < a) verdict = 'helped';
  }
  return {
    verdict,
    before: a,
    after: b,
    guardBefore,
    guardAfter,
    beforeIds: before.map((r) => r.id),
    afterIds: after.map((r) => r.id),
  };
}
