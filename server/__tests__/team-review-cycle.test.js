import { it, expect, vi } from 'vitest';
import { createReviewCycle } from '../pipelines/team-review-cycle.js';
it('serializes shared model calls, alternates priority, and keeps nominations running after reviewer failure', async () => {
  const events = [];
  let release;
  const workflow = vi.fn(async () => {
    events.push('workflow');
    if (events.length === 1)
      await new Promise((r) => {
        release = r;
      });
  });
  const assess = vi.fn(async () => {
    events.push('team');
    throw Error('bad citation');
  });
  const nominate = () => events.push('nominate');
  const warn = vi.fn();
  const tick = createReviewCycle({ workflow, assess, nominate, warn });
  const first = tick();
  await tick();
  release();
  await first;
  await tick();
  expect(events).toEqual(['workflow', 'team', 'nominate', 'team', 'workflow', 'nominate']);
  expect(warn).toHaveBeenCalledTimes(2);
});
