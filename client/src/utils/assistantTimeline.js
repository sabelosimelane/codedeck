function stampOf(kind, item) {
  const time = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN;
  if (Number.isNaN(time)) throw new Error(`Assistant ${kind} ${item.id} has no valid createdAt: ${String(item.createdAt)}`);
  return time;
}

/**
 * The assistant transcript in the order things happened: each proposal card sits where the
 * agent made it, so the replies after it are below it. A proposal made at the same time as a
 * message goes first. Both lists are already in their own order.
 */
export function assistantTimeline(messages, proposals) {
  const items = [];
  let next = 0;
  const stamps = proposals.map(proposal => stampOf('proposal', proposal));
  for (const message of messages) {
    const stamp = stampOf('message', message);
    while (next < proposals.length && stamps[next] <= stamp) items.push({ kind: 'proposal', value: proposals[next++] });
    items.push({ kind: 'message', value: message });
  }
  while (next < proposals.length) items.push({ kind: 'proposal', value: proposals[next++] });
  return items;
}
