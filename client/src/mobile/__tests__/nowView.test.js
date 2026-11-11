import { describe, it, expect } from 'vitest';
import { buildNowView, ago, ACTIVE_WINDOW_MS } from '../nowView';

const NOW = Date.parse('2026-11-10T18:00:00.000Z');
const MIN = 60_000, HOUR = 60 * MIN;
const projects = [{ id: 'p', name: 'Project', state: 'active' }, { id: 'w', name: 'Parked project', state: 'waiting' }, { id: 's', name: 'Shelf', state: 'shelved' }];
const session = (id, extra = {}) => ({ id, incarnationId: `inc-${id}`, projectId: 'p', title: id, status: 'idle', live: true, finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: NOW - 10 * MIN, ...extra });
const view = (sessions, options = {}) => buildNowView({ sessions, projects, now: NOW, scope: 'active', query: '', ...options });
const ids = groups => groups.map(group => group.rows.map(row => row.id));

describe('ago', () => {
  it.each([[0, 'now'], [59_000, 'now'], [MIN, '1m'], [59 * MIN, '59m'], [HOUR, '1h'], [23 * HOUR, '23h'], [24 * HOUR, 'Yesterday'], [47 * HOUR, 'Yesterday'], [48 * HOUR, '2d'], [10 * 24 * HOUR, '10d']])('%i ms is %s', (elapsed, label) => expect(ago(NOW - elapsed, NOW)).toBe(label));
  it('treats a slightly future time as now and an unknown time as blank', () => { expect(ago(NOW + 5000, NOW)).toBe('now'); expect(ago(null, NOW)).toBe(''); });
});

it('shows agent and shell counts in the Now note', () => {
  expect(view([session('delegated', { status: 'running', backgroundAgents: 2 })]).groups[0].rows[0].note).toBe('Running · 2 agents');
  expect(view([session('shell', { status: 'running', backgroundShells: 1 })]).groups[0].rows[0].note).toBe('Running · 1 shell');
});

describe('what counts as active', () => {
  it('shows running, needs-you and recently active sessions, newest activity first', () => {
    const result = view([
      session('old', { lastActivityAt: NOW - ACTIVE_WINDOW_MS - MIN }),
      session('recent', { lastActivityAt: NOW - 30 * MIN }),
      session('finished', { finished: true, lastActivityAt: NOW - 2 * MIN }),
      session('running', { status: 'running', lastActivityAt: NOW - 20 * HOUR }),
      session('input', { needsInput: true, lastActivityAt: NOW - 9 * HOUR }),
    ]);
    expect(ids(result.groups)).toEqual([['finished', 'recent', 'input', 'running']]);
    expect(result.quietCount).toBe(1);
  });
  it('keeps the boundary of the active window inclusive', () => {
    expect(ids(view([session('edge', { lastActivityAt: NOW - ACTIVE_WINDOW_MS })]).groups)).toEqual([['edge']]);
  });
  it('leaves out parked sessions, sessions of waiting or shelved projects, ended and stale ones', () => {
    const result = view([
      session('parked', { waiting: true, status: 'running' }),
      session('project-waiting', { projectId: 'w' }),
      session('shelved', { projectId: 's' }),
      session('ended', { status: 'dead' }),
      session('stale', { live: false, status: 'unknown', lastActivityAt: null }),
      session('here'),
    ]);
    expect(ids(result.groups)).toEqual([['here']]);
    expect(result.quietCount).toBe(5);
  });
  it('orders by title when activity times tie and puts unknown times last', () => {
    const result = view([session('b'), session('a'), session('z', { status: 'running', lastActivityAt: null })]);
    expect(ids(result.groups)).toEqual([['a', 'b', 'z']]);
  });
});

describe('headline', () => {
  it('leads with what is running and follows with what needs you', () => {
    const result = view([session('r1', { status: 'running' }), session('r2', { status: 'running' }), session('f', { finished: true })]);
    expect(result).toMatchObject({ headline: '2 running', subline: '1 needs you', sublineTone: 'needs' });
  });
  it('uses the plural for several', () => {
    expect(view([session('r', { status: 'running' }), session('f', { finished: true }), session('i', { needsInput: true })]).subline).toBe('2 need you');
  });
  it('leads with what needs you when nothing is running', () => {
    expect(view([session('f', { finished: true })])).toMatchObject({ headline: '1 needs you', headlineTone: 'needs', subline: 'Nothing running' });
  });
  it('says so plainly when running work needs nothing from you', () => {
    expect(view([session('r', { status: 'running' })])).toMatchObject({ headline: '1 running', subline: 'Nothing needs you', sublineTone: 'quiet' });
  });
  it('is quiet when nothing is running or waiting on you, and shows the most recent sessions', () => {
    const result = view([session('a', { lastActivityAt: NOW - 30 * HOUR }), session('b', { lastActivityAt: NOW - 20 * HOUR }), session('c', { lastActivityAt: NOW - 50 * HOUR }), session('d', { lastActivityAt: NOW - 90 * HOUR })]);
    expect(result).toMatchObject({ headline: 'All quiet', subline: 'Last activity 20h ago' });
    expect(result.groups).toEqual([expect.objectContaining({ label: 'Most recent', showLabel: true })]);
    expect(ids(result.groups)).toEqual([['b', 'a', 'c']]);
    expect(result.quietCount).toBe(1);
  });
  it('is quiet with recent idle work too, without the "most recent" stand-in', () => {
    const result = view([session('a')]);
    expect(result).toMatchObject({ headline: 'All quiet', subline: 'Last activity 10m ago' });
    expect(result.groups[0]).toMatchObject({ label: 'Active', showLabel: false });
  });
  it('handles no sessions at all', () => {
    expect(view([])).toMatchObject({ headline: 'All quiet', subline: 'No open sessions', groups: [], quietCount: 0 });
  });
  it('does not count muted or parked sessions in the headline', () => {
    const result = view([session('m', { status: 'running', muted: true }), session('f', { finished: true, muted: true }), session('p', { status: 'running', waiting: true })]);
    expect(result).toMatchObject({ headline: 'All quiet' });
  });
});

describe('rows', () => {
  const rowOf = (extra, options) => view([session('x', extra)], { scope: 'all', ...options }).groups.flatMap(group => group.rows)[0];
  it('marks running work as live', () => expect(rowOf({ status: 'running' })).toMatchObject({ tone: 'running', note: 'Running', when: 'now', age: 0, projectName: 'Project' }));
  it('marks finished work and requests for input in the needs-you tone', () => {
    expect(rowOf({ finished: true })).toMatchObject({ tone: 'needs', note: 'Finished', when: '10m' });
    expect(rowOf({ needsInput: true, finished: true })).toMatchObject({ tone: 'needs', note: 'Needs input' });
  });
  it('shows idle work plainly', () => expect(rowOf({})).toMatchObject({ tone: 'idle', note: '', parked: false, muted: false }));
  it('mutes colour but keeps the real state in words', () => {
    expect(rowOf({ status: 'running', muted: true })).toMatchObject({ tone: 'idle', note: 'Running', muted: true, when: 'now' });
    expect(rowOf({ finished: true, muted: true })).toMatchObject({ tone: 'idle', note: 'Finished', muted: true });
  });
  it('shows parked sessions and sessions of waiting projects as waiting, without colour', () => {
    expect(rowOf({ waiting: true, status: 'running' })).toMatchObject({ tone: 'idle', parked: true, note: 'Running' });
    expect(rowOf({ projectId: 'w' })).toMatchObject({ tone: 'idle', parked: true });
  });
  it('labels ended and last-known sessions', () => {
    expect(rowOf({ status: 'dead' })).toMatchObject({ tone: 'ended', note: 'Ended' });
    expect(rowOf({ live: false, status: 'running', lastActivityAt: null })).toMatchObject({ tone: 'idle', note: 'Last known: running', when: '', age: 2 });
  });
  it('fades rows as they age', () => {
    expect(rowOf({ lastActivityAt: NOW - 59 * MIN }).age).toBe(0);
    expect(rowOf({ lastActivityAt: NOW - 2 * HOUR }).age).toBe(1);
    expect(rowOf({ lastActivityAt: NOW - 30 * HOUR }).age).toBe(2);
  });
});

describe('all and search', () => {
  const sessions = [session('active'), session('old', { lastActivityAt: NOW - 40 * HOUR }), session('parked', { waiting: true }), session('other', { projectId: 's', title: 'Deploy script', lastActivityAt: NOW - 3 * HOUR })];
  it('adds everything else under Earlier, still newest first', () => {
    const result = view(sessions, { scope: 'all' });
    expect(result.groups.map(group => [group.label, group.showLabel])).toEqual([['Active', false], ['Earlier', true]]);
    expect(ids(result.groups)).toEqual([['active'], ['parked', 'other', 'old']]);
    expect(result.quietCount).toBe(0);
  });
  it('searches every session by title or project, whatever the scope', () => {
    expect(ids(view(sessions, { query: ' deploy ' }).groups)).toEqual([['other']]);
    expect(ids(view(sessions, { query: 'SHELF' }).groups)).toEqual([['other']]);
    expect(view(sessions, { query: 'nothing-like-this' })).toMatchObject({ groups: [], searching: true });
  });
  it('keeps the headline about the whole instance while searching', () => {
    expect(view([session('r', { status: 'running' }), session('deploy')], { query: 'deploy' }).headline).toBe('1 running');
  });
});

describe('preconditions', () => {
  it('rejects a session whose project is unknown', () => expect(() => view([session('x', { projectId: 'nope' })])).toThrow(/project/));
  it.each([['scope', 'recent'], ['now', -1], ['now', 'today'], ['query', null]])('rejects %s %j', (field, value) => expect(() => view([], { [field]: value })).toThrow(new RegExp(field)));
});
