import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionAttention, attentionStatus } from '../session-attention.js';

const opened = [];
function setup({ start = 1_000_000 } = {}) {
  const db = new Database(':memory:'); opened.push(db);
  let time = start;
  const onLanded = vi.fn();
  const attention = createSessionAttention({ db, now: () => time, onLanded });
  return { db, attention, onLanded, advance: ms => { time += ms; return time; }, time: () => time };
}
const see = (attention, status, extra = {}) => attention.observe({ sessionId: 'p-1', status, activityHint: 500, ...extra });
afterEach(() => opened.splice(0).forEach(db => db.close()));

describe('attentionStatus', () => {
  it.each([
    [{ alive: true, executionStatus: 'running' }, 'running'],
    [{ alive: true, executionStatus: 'idle' }, 'idle'],
    [{ alive: false, executionStatus: 'idle' }, 'dead'],
    [{ alive: true, executionStatus: 'dead' }, 'dead'],
    [{ alive: true, executionStatus: 'unknown' }, 'unknown'],
    [{ alive: true, executionStatus: 'running', reachability: 'unreachable' }, 'unknown'],
    [{ alive: true, executionStatus: 'running', executionReason: 'host_unreachable' }, 'unknown'],
  ])('maps %j to %s like the desktop does', (row, expected) => expect(attentionStatus(row)).toBe(expected));
  it('rejects a status it cannot classify', () => expect(() => attentionStatus({ alive: true, executionStatus: 'busy' })).toThrow(/executionStatus/));
});

describe('finished', () => {
  it('is set when running work goes idle and stays until acknowledged', () => {
    const { attention } = setup();
    see(attention, 'running'); see(attention, 'idle'); see(attention, 'idle');
    expect(attention.state('p-1').finished).toBe(true);
    attention.acknowledge('p-1');
    expect(attention.state('p-1').finished).toBe(false);
  });
  it('is set on running to unknown, as the desktop treats a status flicker', () => {
    const { attention } = setup();
    see(attention, 'running'); see(attention, 'unknown');
    expect(attention.state('p-1').finished).toBe(true);
  });
  it('clears when the session runs again and is never set for a session first seen idle', () => {
    const { attention } = setup();
    see(attention, 'idle');
    expect(attention.state('p-1').finished).toBe(false);
    see(attention, 'running'); see(attention, 'idle'); see(attention, 'running');
    expect(attention.state('p-1').finished).toBe(false);
  });
  it('is not set when running work ends in death', () => {
    const { attention } = setup();
    see(attention, 'running'); see(attention, 'dead');
    expect(attention.state('p-1').finished).toBe(false);
  });
  it('survives a restart of the tracker', () => {
    const { db, attention } = setup();
    see(attention, 'running'); see(attention, 'idle');
    expect(createSessionAttention({ db, now: () => 5, onLanded: () => {} }).state('p-1').finished).toBe(true);
  });
});

describe('landing a parked session', () => {
  it('lands on a real transition into idle while finished', () => {
    const { attention, onLanded } = setup();
    see(attention, 'running'); see(attention, 'idle');
    expect(onLanded).toHaveBeenCalledTimes(1); expect(onLanded).toHaveBeenCalledWith('p-1');
  });
  it('does not land for work that had already finished before it was parked', () => {
    const { attention, onLanded } = setup();
    see(attention, 'running'); see(attention, 'idle'); onLanded.mockClear();
    see(attention, 'idle'); see(attention, 'idle');
    expect(onLanded).not.toHaveBeenCalled();
  });
  it('does not land on a running to unknown flicker, but does when it settles idle', () => {
    const { attention, onLanded } = setup();
    see(attention, 'running'); see(attention, 'unknown');
    expect(onLanded).not.toHaveBeenCalled();
    see(attention, 'idle');
    expect(onLanded).toHaveBeenCalledTimes(1);
  });
  it('lands when a known session dies, once', () => {
    const { attention, onLanded } = setup();
    see(attention, 'idle'); see(attention, 'dead'); see(attention, 'dead');
    expect(onLanded).toHaveBeenCalledTimes(1);
  });
  it('does not land for a session first seen dead', () => {
    const { attention, onLanded } = setup();
    see(attention, 'dead');
    expect(onLanded).not.toHaveBeenCalled();
  });
});

describe('last activity', () => {
  it('starts from the hint and moves only on meaningful changes', () => {
    const { attention, advance } = setup();
    see(attention, 'idle');
    expect(attention.state('p-1').lastActivityAt).toBe(500);
    advance(1000); see(attention, 'idle');
    expect(attention.state('p-1').lastActivityAt).toBe(500);
    const started = advance(1000); see(attention, 'running');
    expect(attention.state('p-1').lastActivityAt).toBe(started);
    advance(60_000); see(attention, 'running');
    expect(attention.state('p-1').lastActivityAt).toBe(started);
    const finished = advance(1000); see(attention, 'idle');
    expect(attention.state('p-1').lastActivityAt).toBe(finished);
  });
  it('moves when the user types, at most once per half minute', () => {
    const { attention, advance } = setup();
    see(attention, 'idle');
    const first = advance(5000); attention.touch('p-1');
    advance(10_000); attention.touch('p-1');
    expect(attention.state('p-1').lastActivityAt).toBe(first);
    const later = advance(30_000); attention.touch('p-1');
    expect(attention.state('p-1').lastActivityAt).toBe(later);
  });
  it('ignores typing in a session it has not observed yet', () => {
    const { attention } = setup();
    attention.touch('p-9');
    expect(attention.state('p-9')).toBeNull();
  });
  it.each([undefined, null, -1, 1.5, 'now'])('requires a valid activity hint for a new session (%j)', activityHint => {
    const { attention } = setup();
    expect(() => attention.observe({ sessionId: 'p-1', status: 'idle', activityHint })).toThrow(/activityHint/);
  });
});

describe('muting', () => {
  it('mutes and unmutes without touching finished', () => {
    const { attention } = setup();
    see(attention, 'running'); see(attention, 'idle');
    attention.setMuted('p-1', true);
    expect(attention.state('p-1')).toMatchObject({ muted: true, finished: true });
    attention.setMuted('p-1', false);
    expect(attention.state('p-1').muted).toBe(false);
  });
  it('does not carry a mute or a finished flag over to a session that reuses a dead id', () => {
    const { attention } = setup();
    see(attention, 'running'); see(attention, 'idle'); attention.setMuted('p-1', true);
    see(attention, 'dead'); see(attention, 'idle');
    expect(attention.state('p-1')).toMatchObject({ muted: false, finished: false });
  });
  it('forgets everything about a deleted session', () => {
    const { attention } = setup();
    see(attention, 'idle'); attention.setMuted('p-1', true); attention.forget('p-1');
    expect(attention.state('p-1')).toBeNull(); expect(attention.knows('p-1')).toBe(false);
  });
});

describe('preconditions', () => {
  it.each(['', ' ', null, 5, 'x'.repeat(257)])('rejects session id %j', sessionId => {
    const { attention } = setup();
    expect(() => attention.observe({ sessionId, status: 'idle', activityHint: 1 })).toThrow(/sessionId/);
    expect(() => attention.setMuted(sessionId, true)).toThrow(/sessionId/);
  });
  it('rejects an unknown status and a non-boolean mute', () => {
    const { attention } = setup();
    expect(() => see(attention, 'busy')).toThrow(/status/);
    see(attention, 'idle');
    expect(() => attention.setMuted('p-1', 'yes')).toThrow(/muted/);
  });
  it('refuses to mute or acknowledge a session it has never observed', () => {
    const { attention } = setup();
    expect(() => attention.setMuted('p-1', true)).toThrow(/not observed/);
    expect(() => attention.acknowledge('p-1')).toThrow(/not observed/);
  });
  it('fails loudly on a corrupted stored row', () => {
    const { db, attention } = setup();
    see(attention, 'idle');
    db.prepare("UPDATE session_attention SET status = 'busy'").run();
    expect(() => attention.state('p-1')).toThrow(/status/);
  });
  it('requires a database, a clock and a landing handler', () => {
    expect(() => createSessionAttention({ now: () => 1, onLanded: () => {} })).toThrow(/db/);
    const db = new Database(':memory:'); opened.push(db);
    expect(() => createSessionAttention({ db, now: 5, onLanded: () => {} })).toThrow(/now/);
    expect(() => createSessionAttention({ db, now: () => 1 })).toThrow(/onLanded/);
  });
});
