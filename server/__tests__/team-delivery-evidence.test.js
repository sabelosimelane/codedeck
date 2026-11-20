import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createDeliveryEvidence } from '../pipelines/team-delivery-evidence.js';

function fixture() {
  const id = randomUUID();
  const db = new Database(':memory:');
  const now = () => '2026-11-20T09:00:00.000Z';
  const sources = [
    { id: 'request', text: 'Rotate the image on the phone' },
    { id: 'note:12', text: 'Device test reported rotation=90 after tapping Rotate.' },
  ];
  const criterion = {
    text: 'Rotate the image on the phone',
    source: 'request',
    verdict: 'met',
    proof: [{ source: 'note:12', check: 'Device test reported', quote: 'rotation=90 after tapping Rotate' }],
  };
  const store = createDeliveryEvidence({ db, now });
  return { id, db, sources, criterion, store };
}
it('requires an original requirement and a traceable observation for every proven criterion', () => {
  const { id, sources, criterion, store } = fixture();
  expect(store.current(id, 'v1')).toBe(null);
  for (const bad of [
    { ...criterion, text: 'Invented' },
    { ...criterion, proof: [] },
    { ...criterion, proof: [{ source: 'request', quote: 'Rotate' }] },
    { ...criterion, proof: [{ source: 'note:12', quote: 'Unit tests passed' }] },
  ]) {
    expect(() => store.record(id, 'v1', sources, { complete: true, criteria: [bad] })).toThrow();
  }
  store.record(id, 'v1', sources, { complete: false, criteria: [criterion] });
  expect(store.current(id, 'v1').criteria.map((c) => c.verdict)).toEqual(['met', 'unverified']);
  expect(store.current(id, 'v2')).toBe(null);
});
it('keeps revision-fenced owner corrections, their evidence, and original reviewer history', () => {
  const { id, sources, criterion, store } = fixture();
  store.record(id, 'v1', sources, { complete: true, criteria: [criterion] });
  const corrected = store.correct(id, 'v1', sources, {
    revision: 1,
    text: criterion.text,
    verdict: 'missed',
    reason: 'On device, tapping Rotate still leaves the image upright.',
  });
  expect(corrected.criteria[0].verdict).toBe('missed');
  expect(corrected.sources.at(-1).text).toMatch(/upright/);
  expect(() =>
    store.correct(id, 'v1', sources, { revision: 1, text: criterion.text, verdict: 'met', reason: 'late' }),
  ).toThrow(/changed/);
  expect(store.history(id).map((r) => r.author)).toEqual(['reviewer', 'owner']);
  expect(() => store.record(id, 'v1', sources, { complete: true, criteria: [criterion] })).toThrow();
});
it('allows the owner to establish evidence before the model has assessed the run', () => {
  const { id, sources, store } = fixture();
  expect(
    store.correct(id, 'v1', sources, {
      revision: 0,
      text: sources[0].text,
      verdict: 'met',
      reason: 'I verified the complete request on my device.',
    }).revision,
  ).toBe(1);
});
it('keeps credential values out of owner correction history', () => {
  const { id, sources, store } = fixture();
  store.correct(id, 'v1', sources, {
    revision: 0,
    text: sources[0].text,
    verdict: 'missed',
    reason: 'Observed failure using api_key=fixture-credential.',
  });
  expect(JSON.stringify(store.history(id))).not.toContain('fixture-credential');
});
it('rejects a note that cites only a completion claim and a bare step approval as proof of delivery', () => {
  const { id, store, criterion, sources } = fixture();
  const records = [
    ...sources,
    { id: 'note:27', text: 'Done' },
    { id: 'review:3', text: 'Verify · approved' },
  ];
  for (const proof of [[{ source: 'note:27', quote: 'Done' }], [{ source: 'review:3', quote: 'approved' }]]) {
    expect(() =>
      store.record(id, 'v1', records, { complete: true, criteria: [{ ...criterion, proof }] }),
    ).toThrow();
  }
});
it('allows a recorded question to explain a requirement but only the actual answer can prove acceptance', () => {
  const { id, store, criterion, sources } = fixture();
  const records = [
    ...sources,
    { id: 'question:3', text: 'Validate · pass 2\nWas rotation verified on your phone?' },
    { id: 'answer:3', text: 'Yes, rotation worked on my phone.' },
  ];
  const requirement = { ...criterion, text: 'rotation verified on your phone', source: 'question:3' };
  expect(() =>
    store.record(id, 'v1', records, {
      complete: true,
      criteria: [{ ...requirement, proof: [{ source: 'question:3', quote: 'rotation verified' }] }],
    }),
  ).toThrow(/proof/);
  expect(
    store.record(id, 'v1', records, {
      complete: true,
      criteria: [{ ...requirement, proof: [{ source: 'answer:3', quote: 'rotation worked on my phone' }] }],
    }).criteria[0].verdict,
  ).toBe('met');
});
