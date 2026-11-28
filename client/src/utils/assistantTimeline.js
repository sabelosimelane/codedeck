function stampOf(kind, item) {
  const time = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN;
  if (Number.isNaN(time)) throw new Error(`Assistant ${kind} ${item.id ?? item.requestId} has no valid createdAt: ${String(item.createdAt)}`);
  return time;
}

/**
 * The assistant transcript in the order things happened. Cards (`{ kind, value }`, such as a
 * proposal or a permission request) sit where they arose among the messages, so the replies
 * after them are below them. A card from the same time as a message goes first; cards of the
 * same time keep their given order.
 */
export function assistantTimeline(messages, cards) {
  const stamped = cards
    .map((card, index) => ({ card, index, time: stampOf(card.kind, card.value) }))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const items = [];
  let next = 0;
  for (const message of messages) {
    const stamp = stampOf('message', message);
    while (next < stamped.length && stamped[next].time <= stamp) items.push(stamped[next++].card);
    items.push({ kind: 'message', value: message });
  }
  while (next < stamped.length) items.push(stamped[next++].card);
  return items;
}

/** A time just after `latest`, for something the socket reports without a time of its own. */
export function stampAfter(latest) {
  const time = Date.parse(latest);
  if (Number.isNaN(time)) throw new Error(`Assistant transcript has no valid latest time: ${String(latest)}`);
  return new Date(time + 1).toISOString();
}
