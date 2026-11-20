// Run from the repository root with Node 22, Playwright and Chrome installed.
// Route browser requests to an in-memory Express app so this never contacts a live CodeDeck instance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createAgentStore } from '../../server/pipelines/agent-store.js';
import { createAnswerStore } from '../../server/pipelines/answer-store.js';
import { createNoteStore } from '../../server/pipelines/note-store.js';
import { createReviewStore } from '../../server/pipelines/review-store.js';
import { createTeamStore } from '../../server/pipelines/library-store.js';
import { createTeamObservations } from '../../server/pipelines/team-observations.js';
import { createTeamTrials } from '../../server/pipelines/team-trials.js';
import { mountTeamScoring } from '../../server/routes/team-scoring.js';
import { parseCollectionQuery } from '../../server/routes/collection-query.js';
import { buildLaunchCommand } from '../../shared/agent-presets.mjs';

function fixture(db) {
  const teams = createTeamStore(db),
    agents = createAgentStore(db);
  const agent = agents.create({
    name: 'Fixer',
    launchCommand: buildLaunchCommand({
      provider: 'codex',
      model: 'model-one',
      effort: 'high',
      skipPermissions: false,
    }).command,
    resetCommand: '/clear',
  });
  const team = teams.create({ name: 'Delivery team', members: [{ role: 'Implementer', agentId: agent.id }] });
  const other = teams.create({ name: 'Second team', members: team.members });
  const workflow = { id: randomUUID(), name: 'Repair', revision: 1 };
  const origin = {
    teamId: team.id,
    teamName: team.name,
    teamRevision: team.revision,
    workload: 'a'.repeat(64),
    mixed: false,
    trialId: null,
  };
  const slot = {
    stepIndex: 0,
    stepName: 'Fix',
    role: 'Implementer',
    source: 'team',
    teamId: team.id,
    teamRevision: team.revision,
    agentId: agent.id,
    agentRevision: agent.revision,
    provider: 'codex',
    model: 'model-one',
    effort: 'high',
  };
  const records = new Map();
  const runs = {
    attributedIds: () => [...records.keys()],
    get: (id) => records.get(id).run,
    attribution: (id) => records.get(id).origin,
  };
  const outcomes = () => [...records.values()].map((r) => r.outcome);
  const model = { outcomes, reviewDelivery: async () => false };
  const observations = createTeamObservations({
    db,
    runs,
    teams,
    improvements: model,
    notes: createNoteStore(db),
    answers: createAnswerStore(db),
    reviews: createReviewStore(db),
  });
  const trials = createTeamTrials({
    db,
    teams,
    agents,
    workflows: { get: () => workflow },
    observations: observations.observations,
  });
  function deliver(measured) {
    const id = randomUUID(),
      status = 'complete',
      input = 'Open the saved setting on the phone';
    const at = new Date(Date.UTC(2026, 10, 19, 12, records.size)).toISOString();
    const run = {
      id,
      workflowId: workflow.id,
      project: 'Demo',
      input,
      status,
      createdAt: new Date(Date.parse(at) - 60000).toISOString(),
      updatedAt: at,
      finishedAt: at,
      steps: [{ attempt: 1, roundsCompleted: 0 }],
      definition: { workflowRevision: 1, workflowName: workflow.name, steps: [{ role: 'Implementer' }] },
    };
    const assignment = measured
      ? trials.reserve({
          ...origin,
          runId: id,
          workflowId: workflow.id,
          workflowRevision: 1,
          project: 'Demo',
          configuration: [slot],
          roles: [slot.role],
        })
      : null;
    if (measured) assert.ok(assignment, 'Expected a reserved trial slot');
    const profile = assignment ? { ...slot, source: 'trial', effort: 'medium' } : slot;
    const activeMs = assignment ? 5000 : 10000;
    records.set(id, {
      run,
      origin: {
        ...origin,
        trialId: assignment?.trialId ?? null,
        configuration: [profile],
        attempts: [{ ...profile, attempt: 1, activeMs }],
      },
      outcome: { id, status, at, activeMs, steps: [{ activeMs }] },
    });
    const evidence = observations.detail(id);
    observations.correct(id, evidence.signature, {
      revision: 0,
      text: input,
      verdict: 'met',
      reason: 'Device check confirmed the setting opened.',
    });
    return id;
  }
  for (let i = 0; i < 5; i++) deliver(false);
  trials.refresh();
  return { service: { ...observations, trials }, deliver, teams, team, other, agents, agent };
}

async function browserAcceptance(page, fixture) {
  const app = express();
  app.use(express.json());
  class PipelineError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  const fieldError = (field, message) => new PipelineError(field + ': ' + message, 400);
  mountTeamScoring({
    router: app,
    service: fixture.service,
    route: (fn) => (req, res, next) =>
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next),
    parseCollectionQuery: (query, options) => parseCollectionQuery(query, options, fieldError),
    fieldError,
    PipelineError,
  });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));
  const bundle = await build({
    stdin: {
      contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import Improvements from './src/components/pipelines/builder/Improvements.jsx';
    createRoot(document.querySelector('main')).render(React.createElement(Improvements,{workflows:[]}));
    `,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    outfile: 'test.js',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const assets = new Map(bundle.outputFiles.map((f) => [f.path.split('/').at(-1), f.text]));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, 'codedeck.test');
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<main></main><link rel="stylesheet" href="/test.css"><script src="/test.js"></script>',
      });
    if (assets.has(url.pathname.slice(1)))
      return route.fulfill({
        contentType: url.pathname.endsWith('css') ? 'text/css' : 'text/javascript',
        body: assets.get(url.pathname.slice(1)),
      });
    if (url.pathname.startsWith('/api/pipelines/improvements/teams/')) {
      const method = route.request().method().toLowerCase();
      let req = request(app)[method](url.pathname + url.search);
      if (route.request().postData()) req = req.send(route.request().postDataJSON());
      const { status, body } = await req;
      return route.fulfill({ status, json: body });
    }
    if (url.pathname.endsWith('/status'))
      return route.fulfill({
        json: {
          configured: true,
          dailyBudget: 10,
          modelRevision: 1,
          model: 'demo',
          provider: 'codex',
          effort: null,
          reviewerRevision: 1,
          queued: 0,
        },
      });
    return route.fulfill({ json: { data: [], page: { hasNextPage: false } } });
  });
  await page.goto('http://codedeck.test/');
  await page.getByRole('button', { name: 'Teams', exact: true }).click();
  const card = page.getByRole('region', { name: 'Delivery team scorecard' });
  await card.getByRole('button', { name: /5 timed deliveries/ }).click();
  await page
    .getByRole('button', { name: /Demo · Repair/ })
    .first()
    .click();
  const evidence = page.getByRole('region', { name: 'Team run evidence' });
  await evidence.getByRole('button', { name: 'Correct verdict' }).click();
  await evidence.getByLabel('Reason').fill('I verified the fix on a second phone.');
  await evidence.getByRole('button', { name: 'Save correction' }).click();
  await evidence.getByText('Correction saved.').waitFor();
  await evidence.getByRole('button', { name: 'Verdict history' }).click();
  await evidence.getByText(/Revision 2 · owner/).waitFor();
  await evidence.getByRole('button', { name: 'Close evidence' }).click();
  console.log('Browser verified median delivery, accuracy drill-down, cited owner correction and history.');

  await page.getByRole('button', { name: 'Start measured trial' }).click();
  await page.getByRole('button', { name: 'End trial early' }).waitFor();
  const [trial] = fixture.service.trials.list();
  assert.equal(trial.status, 'running');
  for (let i = 0; i < 5; i++) fixture.deliver(true);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText(/Observed trial outcome · helped/).waitFor();
  await page.getByRole('button', { name: 'Adopt for this team role' }).click();
  await page.getByText('Team role updated.').waitFor();
  assert.equal(fixture.teams.get(fixture.team.id).revision, 2);
  assert.equal(fixture.teams.get(fixture.other.id).members[0].agentId, fixture.agent.id);
  assert.equal(fixture.agents.get(fixture.agent.id).revision, 1);
  assert.deepEqual(errors, []);
  console.log(
    'Browser verified five trial assignments, before/after results and separate adoption. The other team kept its original agent.',
  );
}
const db = new Database(':memory:');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  try {
    await browserAcceptance(page, fixture(db));
  } catch (error) {
    console.error(await page.locator('body').innerText());
    throw error;
  }
} finally {
  await browser.close();
  db.close();
}
