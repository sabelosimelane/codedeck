import { describe, expect, it } from 'vitest';
import { parsePhaseBreakdown, parsePhaseProgress } from '../pipelines/run-progress.js';

describe('parsePhaseBreakdown', () => {
  it('counts every phase, ends one at a non-phase heading, and ignores fences', () => {
    const markdown = '## Phase 1: Setup\n- [x] done\n# Notes\n- [ ] ignored\n~~~\n## Phase 9: Fake\n- [ ] fake\n~~~\n## Phase 2 — Build\n- [X] done\n- [ ] next\n## Appendix\n- [ ] ignored';
    expect(parsePhaseBreakdown(markdown)).toEqual([
      { number: 1, title: 'Setup', done: 1, total: 1 },
      { number: 2, title: 'Build', done: 1, total: 2 },
    ]);
    expect(parsePhaseProgress(markdown)).toEqual({ phaseCount: 2, phase: { number: 2, position: 2, title: 'Build', tasksDone: 1, tasksTotal: 2 }, tasksDone: 2, tasksTotal: 3 });
  });
  it('rejects a non-string markdown value', () => expect(() => parsePhaseBreakdown(null)).toThrow('markdown'));
});
