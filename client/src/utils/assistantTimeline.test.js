import { describe, expect, it } from 'vitest';
import { assistantTimeline, stampAfter } from './assistantTimeline.js';

const message = (id, role, createdAt) => ({ id, role, content: `${role} ${id}`, createdAt });
const proposal = (id, createdAt) => ({ kind: 'proposal', value: { id, createdAt } });
const permission = (requestId, createdAt) => ({ kind: 'permission', value: { requestId, createdAt } });
const order = items => items.map(item => `${item.kind}:${item.value.id ?? item.value.requestId}`);

describe('assistantTimeline', () => {
  it('places each card where it arose, so replies after it are below it', () => {
    const items = assistantTimeline(
      [
        message(1, 'owner', '2026-11-28T12:00:00.000Z'),
        message(2, 'tool', '2026-11-28T12:00:01.000Z'),
        message(3, 'agent', '2026-11-28T12:00:03.000Z'),
        message(4, 'owner', '2026-11-28T12:05:00.000Z'),
        message(5, 'agent', '2026-11-28T12:05:09.000Z'),
      ],
      [proposal('p1', '2026-11-28T12:00:02.000Z'), permission(90, '2026-11-28T12:05:05.000Z')],
    );
    expect(order(items)).toEqual(['message:1', 'message:2', 'proposal:p1', 'message:3', 'message:4', 'permission:90', 'message:5']);
  });

  it('puts a card from the same time as a message before that message', () => {
    const items = assistantTimeline([message(1, 'agent', '2026-11-28T12:00:00.000Z')], [proposal('p1', '2026-11-28T12:00:00.000Z')]);
    expect(items.map(item => item.kind)).toEqual(['proposal', 'message']);
  });

  it('orders cards of different kinds by time, keeping the given order on a tie', () => {
    const items = assistantTimeline(
      [message(1, 'agent', '2026-11-28T12:00:00.000Z')],
      [proposal('p2', '2026-11-28T12:00:06.000Z'), permission(90, '2026-11-28T12:00:05.000Z'), proposal('p3', '2026-11-28T12:00:06.000Z')],
    );
    expect(order(items)).toEqual(['message:1', 'permission:90', 'proposal:p2', 'proposal:p3']);
  });

  it('fails loudly on a message or card without a valid createdAt', () => {
    expect(() => assistantTimeline([message(1, 'agent', undefined)], [])).toThrow(/message 1.*createdAt/);
    expect(() => assistantTimeline([], [proposal('p1', 'yesterday')])).toThrow(/proposal p1.*createdAt/);
    expect(() => assistantTimeline([], [permission(90, null)])).toThrow(/permission 90.*createdAt/);
  });
});

describe('stampAfter', () => {
  it('is one millisecond after the latest time, so live items keep their arrival order', () => {
    expect(stampAfter('2026-11-28T12:00:00.000Z')).toBe('2026-11-28T12:00:00.001Z');
  });

  it('fails loudly without a valid latest time', () => {
    expect(() => stampAfter(null)).toThrow(/latest time/);
  });
});
