import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createTeamObservations } from '../pipelines/team-observations.js';
import { createNoteStore } from '../pipelines/note-store.js';
import { createAnswerStore } from '../pipelines/answer-store.js';
import { createReviewStore } from '../pipelines/review-store.js';
const stamp = '2026-11-20T09:05:00.000Z';
function fixture() {
  const db = new Database(':memory:');
  const run = {
    id: randomUUID(),
    workflowId: randomUUID(),
    project: 'Demo',
    status: 'complete',
    input: 'Rotate the image',
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: stamp,
    finishedAt: stamp,
    definition: { workflowRevision: 2, workflowName: 'Repair', steps: [{ role: 'Fix' }] },
  };
  const agentId = randomUUID(),
    teamId = randomUUID();
  const origin = {
    teamId,
    teamName: 'Builders',
    teamRevision: 2,
    mixed: false,
    trialId: null,
    workload: 'key',
    configuration: [{ stepIndex: 0, role: 'Fix', source: 'team', agentId, agentRevision: 3 }],
    attempts: [],
  };
  const outcome = {
    id: run.id,
    status: 'complete',
    at: stamp,
    activeMs: 1200,
    elapsedMs: 2000,
    steps: [{ activeMs: 1200 }],
  };
  const store = { attributedIds: () => [run.id], attribution: () => origin, get: () => run };
  const notes = createNoteStore(db),
    answers = createAnswerStore(db),
    reviews = createReviewStore(db);
  const note = notes.add({
    runId: run.id,
    stepIndex: 0,
    attempt: 1,
    pass: 1,
    stepName: 'Verify',
    summary: 'Device rotation',
    content: 'Observed 90 degrees on phone.',
    status: 'written',
  });
  const deps = {
    db,
    runs: store,
    teams: { list: () => [{ id: teamId, name: 'Builders', revision: 2 }] },
    notes,
    answers,
    reviews,
    improvements: {
      outcomes: () => [outcome],
      reviewDelivery: vi.fn(async (id, rev, packet, accept) => {
        expect(packet.sources.some((s) => s.text.includes('90 degrees'))).toBe(true);
        accept({
          complete: true,
          criteria: [
            {
              text: run.input,
              source: 'request',
              verdict: 'met',
              proof: [
                {
                  source: 'note:' + note.id,
                  check: 'Device rotation',
                  quote: 'Observed 90 degrees on phone.',
                },
              ],
            },
          ],
        });
        return true;
      }),
    },
  };
  return { service: createTeamObservations(deps), deps, run, origin };
}
it('shows speed before verification, assesses once, and updates scores from a cited owner correction', async () => {
  const { service, deps, run } = fixture();
  expect(service.cards()[0].score.metrics.accuracy.value).toBe(null);
  await service.assessNext();
  await service.assessNext();
  expect(deps.improvements.reviewDelivery).toHaveBeenCalledTimes(1);
  const detail = service.detail(run.id);
  expect(detail).toMatchObject({ verdict: 'met', request: run.input, activeMs: 1200, revision: 1 });
  expect(service.cards()[0].score.metrics.accuracy.value).toBe(1);
  expect(service.cards()[0].score.metrics.elapsedMs.value).toBe(300000);
  service.correct(run.id, detail.signature, {
    revision: 1,
    text: run.input,
    verdict: 'missed',
    reason: 'On my phone the image remained upright.',
  });
  expect(service.cards()[0].score.metrics.accuracy.value).toBe(0);
  expect(service.history(run.id)).toHaveLength(2);
  expect(() => service.correct(run.id, 'stale', {})).toThrow(/changed/);
});
it('accounts for mixed and unfinished runs and shows empty teams without inheriting historical scores', async () => {
  const { service, run, origin, deps } = fixture();
  origin.mixed = true;
  expect(service.cards()[0].score.mixed).toBe(1);
  expect(service.runs()[0].mixed).toBe(true);
  origin.mixed = false;
  run.status = 'running';
  expect(service.cards()[0].score.unfinished).toBe(1);
  await service.assessNext();
  expect(deps.improvements.reviewDelivery).not.toHaveBeenCalled();
  deps.runs.attributedIds = () => [];
  expect(service.cards()[0].score.total).toBe(0);
});
it('identifies each scorecard configuration and counts only attributable attempt timing on mixed runs', () => {
  const { service, origin } = fixture();
  Object.assign(origin, {
    mixed: true,
    attempts: [
      { teamId: origin.teamId, role: 'Fix', activeMs: 555 },
      { teamId: randomUUID(), role: 'Fix', activeMs: 9000 },
    ],
  });
  const [card] = service.cards();
  expect(card.configuration).toEqual(origin.configuration);
  expect(card.score.roles[0].activeMs).toBe(555);
  expect(service.detail(service.runs()[0].id).attempts).toHaveLength(2);
});
it('redacts credentials from evidence before reviewing, returning, or persisting packets', async () => {
  const { service, deps, run } = fixture();
  run.input = 'Rotate the image. api_key=example-test-value';
  expect(service.detail(run.id).request).not.toContain('example-test-value');
  deps.improvements.reviewDelivery = vi.fn(async (_id, _rev, packet, accept) => {
    expect(JSON.stringify(packet)).not.toContain('example-test-value');
    accept({ complete: false, criteria: [] });
    return true;
  });
  await service.assessNext();
  expect(JSON.stringify(service.history(run.id))).not.toContain('example-test-value');
});

function writeNote(deps, run, content, status = 'written') {
  return deps.notes.add({
    runId: run.id,
    stepIndex: 0,
    attempt: 1,
    pass: 2,
    stepName: 'Verify',
    status,
    summary: status === 'written' ? 'Verified' : null,
    content,
  });
}
it('rejects a review and a stale owner decision when final notes arrive during assessment', async () => {
  const { service, deps, run } = fixture();
  const original = service.detail(run.id);
  deps.improvements.reviewDelivery.mockImplementationOnce(async (_id, _rev, _packet, accept) => {
    writeNote(deps, run, 'Final device check found no rotation.');
    accept({ complete: false, criteria: [] });
  });
  await expect(service.assessNext()).rejects.toThrow(/changed/);
  expect(service.history(run.id)).toEqual([]);
  expect(() =>
    service.correct(run.id, original.signature, {
      revision: 0,
      text: run.input,
      verdict: 'met',
      reason: 'Observed rotation.',
    }),
  ).toThrow(/changed/);
  expect(service.detail(run.id).signature).not.toBe(original.signature);
  await service.assessNext();
  expect(service.history(run.id)).toHaveLength(1);
});
it('keeps owner corrections and reassesses other criteria after new evidence on the same delivery', async () => {
  const { service, deps, run } = fixture();
  run.input = 'Rotate the image and save the result';
  const met = (text) => ({
    text,
    source: 'request',
    verdict: 'met',
    proof: [{ source: 'note:1', check: 'Device rotation', quote: 'Observed 90 degrees on phone.' }],
  });
  const model = vi.fn(async (_id, _rev, _packet, accept) =>
    accept({ complete: true, criteria: [met('Rotate the image'), met('save the result')] }),
  );
  deps.improvements.reviewDelivery = model;
  await service.assessNext();
  const before = service.detail(run.id);
  const oldDelivery = service.observations()[0].deliverySignature;
  service.correct(run.id, before.signature, {
    revision: 1,
    text: 'Rotate the image',
    verdict: 'missed',
    reason: 'On my phone the image remained upright.',
  });
  writeNote(deps, run, 'Additional verification now available.');
  const fresh = service.detail(run.id);
  expect(fresh.signature).not.toBe(before.signature);
  expect(service.observations()[0].deliverySignature).toBe(oldDelivery);
  expect(fresh.criteria.map((c) => c.verdict)).toEqual(['missed', 'unverified']);
  expect(fresh.sources.some((s) => s.text.includes('Additional verification'))).toBe(true);
  await service.assessNext();
  expect(model).toHaveBeenCalledTimes(2);
  expect(service.detail(run.id).criteria.map((c) => c.verdict)).toEqual(['missed', 'met']);
  expect(service.history(run.id).map((r) => r.author)).toEqual(['reviewer', 'owner', 'reviewer']);
  run.finishedAt = '2026-11-20T09:10:00.000Z';
  expect(service.observations()[0].deliverySignature).not.toBe(oldDelivery);
  await service.assessNext();
  expect(service.detail(run.id).criteria.map((c) => c.verdict)).toEqual(['met', 'met']);
});
it('keeps written proof past unchanged pass records and identifies the question separately from the answer', () => {
  const { service, deps, run } = fixture();
  for (let i = 0; i < 12; i++) writeNote(deps, run, null, 'unchanged');
  deps.answers.add({
    runId: run.id,
    stepIndex: 0,
    stepName: 'Clarify',
    pass: 2,
    questions: 'Should a missing tag prompt?',
    answer: 'Yes.',
  });
  const sources = service.detail(run.id).sources;
  expect(sources).toContainEqual({ id: 'answer:1', text: 'Yes.' });
  expect(sources.find((s) => s.id === 'question:1')?.text).toMatch(/Clarify.*2[\s\S]*missing tag prompt/);
  expect(sources.some((s) => s.text.includes('Observed 90 degrees'))).toBe(true);
});
