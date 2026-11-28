import { describe, expect, it } from 'vitest';
import { assistantTimeline } from './assistantTimeline.js';

const message = (id, role, createdAt) => ({ id, role, content: `${role} ${id}`, createdAt });
const proposal = (id, createdAt) => ({ id, createdAt });

describe('assistantTimeline', () => {
  it('places each proposal where it was made, so replies after it are below it', () => {
    const items = assistantTimeline(
      [
        message(1, 'owner', '2026-11-28T12:00:00.000Z'),
        message(2, 'tool', '2026-11-28T12:00:01.000Z'),
        message(3, 'agent', '2026-11-28T12:00:03.000Z'),
        message(4, 'owner', '2026-11-28T12:05:00.000Z'),
        message(5, 'agent', '2026-11-28T12:05:09.000Z'),
      ],
      [proposal('p1', '2026-11-28T12:00:02.000Z')],
    );
    expect(items.map(item => `${item.kind}:${item.value.id}`)).toEqual([
      'message:1', 'message:2', 'proposal:p1', 'message:3', 'message:4', 'message:5',
    ]);
  });

  it('puts a proposal made at the same time as a message before that message', () => {
    const items = assistantTimeline([message(1, 'agent', '2026-11-28T12:00:00.000Z')], [proposal('p1', '2026-11-28T12:00:00.000Z')]);
    expect(items.map(item => item.kind)).toEqual(['proposal', 'message']);
  });

  it('keeps proposals newer than every message at the end, in their own order', () => {
    const items = assistantTimeline(
      [message(1, 'agent', '2026-11-28T12:00:00.000Z')],
      [proposal('p1', '2026-11-28T12:00:05.000Z'), proposal('p2', '2026-11-28T12:00:06.000Z')],
    );
    expect(items.map(item => `${item.kind}:${item.value.id}`)).toEqual(['message:1', 'proposal:p1', 'proposal:p2']);
  });

  it('fails loudly on a message or proposal without a valid createdAt', () => {
    expect(() => assistantTimeline([message(1, 'agent', undefined)], [])).toThrow(/message 1.*createdAt/);
    expect(() => assistantTimeline([], [proposal('p1', 'yesterday')])).toThrow(/proposal p1.*createdAt/);
  });
});
