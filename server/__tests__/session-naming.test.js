import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createNamingStore } from '../session-naming-store.js';
import { createNamingService, observesSubmission } from '../session-naming-service.js';
import { validateSettings, validateCatalog, parseTitle } from '../session-naming-validation.js';

const settings = { provider: 'claude', model: 'sonnet', effort: null };
const databases = [];
const services = [];
function setup(generate = vi.fn(async () => 'Fix login redirects')) {
  const db = new Database(':memory:'); databases.push(db);
  const store = createNamingStore(db);
  store.saveSettings(settings);
  const service = createNamingService({ store, generate, capture: async () => 'Fix the login redirect bug' });
  services.push(service);
  return { db, store, service, generate };
}
afterEach(() => { services.splice(0).forEach(service => service.stop()); databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
const activity = { executionStatus: 'running', snapshotText: '› Fix login redirects\nWorking…' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('session naming', () => {
  it('waits for a submission and activity, then names exactly once', async () => {
    const { service, store, generate } = setup();
    service.observe('Demo-1', activity);
    expect(generate).not.toHaveBeenCalled();
    service.input('Demo-1', 'fix login\r');
    service.observe('Demo-1', activity);
    service.observe('Demo-1', activity);
    await service.waitForIdle();
    expect(store.get('Demo-1')).toMatchObject({ title: 'Fix login redirects', state: 'named', source: 'generated' });
    service.input('Demo-1', 'more work\r'); service.observe('Demo-1', activity);
    await service.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each(['generated', 'manual'])('clears a %s title and names only after the next prompt', async source => {
    const { service, store, generate } = setup();
    if (source === 'manual') service.rename('Demo-1', 'Custom title');
    else {
      service.input('Demo-1', 'old task\r'); service.observe('Demo-1', activity);
      await service.waitForIdle();
    }
    generate.mockClear(); generate.mockResolvedValue('Build a dashboard');
    service.input('Demo-1', '/cl'); service.input('Demo-1', 'ear\r');
    expect(store.get('Demo-1')).toMatchObject({ title: null, state: 'waiting', source: null, error: null });
    service.observe('Demo-1', activity); await service.waitForIdle();
    expect(generate).not.toHaveBeenCalled();
    const freshActivity = { executionStatus: 'running', snapshotText: '› Build a dashboard\nWorking…' };
    service.input('Demo-1', 'build a dashboard\r'); service.observe('Demo-1', freshActivity);
    await service.waitForIdle();
    expect(store.get('Demo-1')).toMatchObject({ title: 'Build a dashboard', state: 'named' });
    expect(generate).toHaveBeenCalledExactlyOnceWith(settings, freshActivity.snapshotText);
  });
  it.each(['resolve', 'reject'])('ignores an old naming result that %ss after clearing context', async outcome => {
    let resolve, reject;
    const pending = new Promise((res, rej) => { resolve = res; reject = rej; });
    const { service, store, generate } = setup(vi.fn().mockReturnValueOnce(pending).mockResolvedValue('New context'));
    service.input('Demo-1', 'old task\r'); service.observe('Demo-1', activity);
    await vi.waitFor(() => expect(store.get('Demo-1').state).toBe('generating'));
    service.input('Demo-1', '/clear\r');
    if (outcome === 'resolve') resolve('Old context'); else reject(new Error('offline'));
    await service.waitForIdle();
    expect(store.get('Demo-1')).toMatchObject({ title: null, state: 'waiting', error: null });
    service.input('Demo-1', 'new task\r'); service.observe('Demo-1', activity);
    await service.waitForIdle(); expect(store.get('Demo-1').title).toBe('New context');
  });
  it('cancels scheduled naming retries when context is cleared', async () => {
    vi.useFakeTimers();
    const { service, store, generate } = setup(vi.fn().mockRejectedValue(new Error('offline')));
    service.input('Demo-1', 'task\r'); service.observe('Demo-1', activity); await service.waitForIdle();
    service.input('Demo-1', '/clear\r');
    await vi.advanceTimersByTimeAsync(60000); await service.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.get('Demo-1')).toMatchObject({ title: null, state: 'waiting' });
  });
  it.each(['/clearance\r', 'discuss /clear\r', '/ clear\r', '/clear\x03\r', '\x1b[200~/clear\nmore\x1b[201~\r'])('does not clear for unrelated or cancelled input: %j', data => {
    const { service, store } = setup(); service.rename('Demo-1', 'Keep this title');
    service.input('Demo-1', data);
    expect(store.get('Demo-1')).toMatchObject({ title: 'Keep this title', state: 'manual' });
  });
  it.each(['/clear\x1b[13u', '/clearx\x7f\r', '/clear\rnext task\r'])('recognizes clear with terminal editing or another submission: %j', data => {
    const { service, store } = setup(); service.rename('Demo-1', 'Old title');
    service.input('Demo-1', data);
    expect(store.get('Demo-1')).toMatchObject({ title: null, state: 'waiting' });
  });
  it('does nothing until configured', async () => {
    const { service, store, generate } = setup(); store.saveSettings(null);
    service.input('Demo-1', 'task\r'); service.observe('Demo-1', activity);
    await service.waitForIdle(); expect(generate).not.toHaveBeenCalled();
  });
  it('retains a real submission made while the startup-context check is pending', async () => {
    const pending = deferred(); const generate = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce('Fix login redirects');
    const { service, store } = setup(generate);
    service.input('Demo-1', 'cli\r'); service.observe('Demo-1', activity);
    await vi.waitFor(() => expect(store.get('Demo-1').state).toBe('generating'));
    service.input('Demo-1', 'fix the login redirect\r');
    pending.resolve(null); await service.waitForIdle();
    service.observe('Demo-1', activity); await service.waitForIdle();
    expect(store.get('Demo-1').title).toBe('Fix login redirects');
  });
  it('does not send queued work with an obsolete model selection', async () => {
    const pending = deferred(); const generate = vi.fn(() => pending.promise);
    const { service, store } = setup(generate);
    for (const id of ['Demo-1', 'Demo-2', 'Demo-3']) { service.input(id, 'task\r'); service.observe(id, activity); }
    await vi.waitFor(() => expect(store.get('Demo-2').state).toBe('generating'));
    store.saveSettings({ ...settings, model: 'changed-model' });
    pending.resolve('Task title'); await service.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(2); expect(store.get('Demo-3').state).toBe('failed');
  });
  it('does not mistake pasted multiline text for a submission', () => {
    const state = {};
    expect(observesSubmission(state, '\x1b[200~first\nsecond')).toBe(false);
    expect(observesSubmission(state, '\nthird\x1b[201~')).toBe(false);
    expect(observesSubmission(state, '\r')).toBe(true);
  });
  it('ignores terminal control replies and accepts extended enter keys', () => {
    const state = {};
    expect(observesSubmission(state, '\x1b[12;4R')).toBe(false);
    expect(observesSubmission(state, 'task\x1b[13u')).toBe(true);
  });
  it('rearms insufficient context only after another submission', async () => {
    const generate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('Repair login redirect');
    const { service, store } = setup(generate);
    service.input('Demo-1', 'cli\r'); service.observe('Demo-1', activity);
    await service.waitForIdle(); expect(store.get('Demo-1').state).toBe('waiting');
    service.observe('Demo-1', activity); await service.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(1);
    service.input('Demo-1', 'fix login\r'); service.observe('Demo-1', activity);
    await service.waitForIdle(); expect(store.get('Demo-1').state).toBe('named');
  });
  it('keeps at most two requests running and does not block observations', async () => {
    const pending = deferred(); const { service, store, generate } = setup(() => pending.promise);
    for (let i = 1; i <= 3; i++) { service.input(`Demo-${i}`, 'task\r'); service.observe(`Demo-${i}`, activity); }
    await vi.waitFor(() => expect(store.get('Demo-2').state).toBe('generating'));
    expect(store.get('Demo-3').state).toBe('queued');
    pending.resolve('Fix login redirects'); await service.waitForIdle();
    expect(store.get('Demo-3').state).toBe('named');
  });
  it('does not overwrite a manual rename or resurrect a deleted session', async () => {
    const pending = deferred(); const { service, store } = setup(() => pending.promise);
    for (const id of ['Demo-1', 'Demo-2']) { service.input(id, 'task\r'); service.observe(id, activity); }
    await vi.waitFor(() => expect(store.get('Demo-2').state).toBe('generating'));
    service.rename('Demo-1', 'My own title'); service.remove('Demo-2');
    pending.resolve('Generated title'); await service.waitForIdle();
    expect(store.get('Demo-1')).toMatchObject({ title: 'My own title', state: 'manual' });
    expect(store.get('Demo-2')).toBeNull();
  });
  it('ignores empty enters and terminal replies before task input', () => {
    const state = {};
    expect(observesSubmission(state, '\r')).toBe(false);
    expect(observesSubmission(state, '\x1b[12;4R\r')).toBe(false);
    expect(observesSubmission(state, 'task\x7f\x7f\x7f\x7f\r')).toBe(false);
    expect(observesSubmission(state, 'real task\r')).toBe(true);
  });
  it('automatically retries failures after ten seconds with fresh context', async () => {
    vi.useFakeTimers();
    const generate = vi.fn().mockRejectedValueOnce(new Error('private upstream error')).mockResolvedValue('Fix login redirects');
    const { service, store } = setup(generate);
    service.input('Demo-1', 'task\r'); service.observe('Demo-1', activity); await service.waitForIdle();
    expect(store.get('Demo-1')).toMatchObject({ state: 'queued', title: null });
    expect(JSON.stringify(store.get('Demo-1'))).not.toContain('private upstream');
    await vi.advanceTimersByTimeAsync(9999); expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await service.waitForIdle();
    expect(generate).toHaveBeenLastCalledWith(settings, 'Fix the login redirect bug');
    expect(store.get('Demo-1').state).toBe('named');
  });
  it('stops automatic retries at one minute and allows manual retry', async () => {
    vi.useFakeTimers();
    const generate = vi.fn().mockRejectedValue(new Error('offline'));
    const { service, store } = setup(generate);
    service.input('Demo-1', 'task\r'); service.observe('Demo-1', activity); await service.waitForIdle();
    await vi.advanceTimersByTimeAsync(60000); await service.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(7);
    expect(store.get('Demo-1').state).toBe('failed');
    await vi.advanceTimersByTimeAsync(60000); expect(generate).toHaveBeenCalledTimes(7);
    generate.mockResolvedValue('Recovered task title'); service.retry('Demo-1'); await service.waitForIdle();
    expect(store.get('Demo-1').state).toBe('named');
  });
  it('does not restart the retry window for input already included in a retry snapshot', async () => {
    vi.useFakeTimers(); const generate = vi.fn().mockRejectedValue(new Error('offline'));
    const { service, store } = setup(generate);
    service.input('Demo-1', 'task\r'); service.observe('Demo-1', activity); await service.waitForIdle();
    service.input('Demo-1', 'more context\r');
    await vi.advanceTimersByTimeAsync(60000); await service.waitForIdle();
    service.observe('Demo-1', activity); await service.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(7); expect(store.get('Demo-1').state).toBe('failed');
  });
  it('cancels scheduled retries when renamed or deleted', async () => {
    vi.useFakeTimers();
    const generate = vi.fn().mockRejectedValue(new Error('offline'));
    const { service, store } = setup(generate);
    for (const id of ['Demo-1', 'Demo-2']) { service.input(id, 'task\r'); service.observe(id, activity); }
    await service.waitForIdle(); service.rename('Demo-1', 'Manual title'); service.remove('Demo-2');
    await vi.advanceTimersByTimeAsync(60000);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(store.get('Demo-1').title).toBe('Manual title'); expect(store.get('Demo-2')).toBeNull();
  });
  it('rearms a previously failed session on the next real submission', async () => {
    const { service, store } = setup();
    store.ensure('Demo-1'); store.update('Demo-1', { state: 'failed', error: 'Interrupted' });
    service.input('Demo-1', 'fix login\r'); service.observe('Demo-1', activity);
    await service.waitForIdle(); expect(store.get('Demo-1').state).toBe('named');
  });
  it('marks interrupted jobs failed on restart and validates persisted fields', () => {
    const { store, db } = setup(); store.ensure('Demo-1'); store.update('Demo-1', { state: 'queued' });
    const reopened = createNamingStore(db); expect(reopened.get('Demo-1').state).toBe('failed');
    db.prepare('UPDATE terminal_titles SET value = ? WHERE session_id = ?').run('{"title":"bad"}', 'Demo-1');
    expect(() => reopened.get('Demo-1')).toThrow();
  });
});

describe('naming boundaries', () => {
  it.each(['baseUrl', 'provider', 'model', 'effort'])('rejects a missing settings field: %s', field => {
    const value = { ...settings }; delete value[field]; expect(() => validateSettings(value)).toThrow();
  });
  it.each(['file:///tmp/x', 'http://user:secret@host', 'https://host/?token=secret', ''])('rejects invalid endpoint %s', baseUrl => {
    expect(() => validateSettings({ ...settings, baseUrl })).toThrow();
  });
  it('validates provider and model catalog fields', () => {
    const provider = { id: 'test', enabled: true, available: true, models: ['small'], effort: [], defaultModel: 'small', capabilities: {}, toolPolicies: [] };
    expect(validateCatalog({ providers: [provider], defaultProvider: 'test' })).toHaveLength(1);
    for (const field of ['id', 'enabled', 'available', 'models', 'effort', 'defaultModel', 'capabilities', 'toolPolicies']) {
      const invalid = { ...provider }; delete invalid[field]; expect(() => validateCatalog({ providers: [invalid], defaultProvider: 'test' })).toThrow();
    }
  });
  it('accepts only a bounded title or explicit insufficient context', () => {
    expect(parseTitle('{"title":"Fix login redirects"}')).toBe('Fix login redirects');
    expect(parseTitle('{"title":null}')).toBeNull();
    for (const value of ['oops', '{}', '{"title":""}', JSON.stringify({ title: 'x'.repeat(61) }), '{"title":"a\\nb"}']) {
      expect(() => parseTitle(value)).toThrow();
    }
  });
});

it('retires legacy Conduit settings while preserving saved titles', () => {
  const { db, store } = setup(); store.ensure('Demo-1');
  store.update('Demo-1', { title: 'Keep title', state: 'manual', source: 'manual' });
  db.prepare('UPDATE session_naming_settings SET value=?').run(JSON.stringify({ baseUrl: 'https://old.test', provider: 'old', model: 'old', effort: null }));
  const reopened = createNamingStore(db);
  expect(reopened.settings()).toBeNull();
  expect(reopened.get('Demo-1').title).toBe('Keep title');
});
