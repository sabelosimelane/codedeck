import { describe, expect, it } from 'vitest';
import { landingStatus, nextLandingStep, waitingReasons } from '../landingSteps.js';

const none = { commit: [], merge: [], pullRequest: [], close: [] };
const entry = (overrides = {}) => ({
  filesPresent: true, runActive: false, baseBranch: 'main', uncommittedCount: 0, commitsAhead: 0, commitsBehind: 0,
  alreadyInBase: false, prUrl: null, blockers: { ...none }, ...overrides,
});

describe('nextLandingStep', () => {
  it('asks for a commit while files are uncommitted', () => {
    expect(nextLandingStep(entry({ uncommittedCount: 3, commitsAhead: 2 }))).toBe('commit');
  });

  it('offers no commit the backend refuses', () => {
    expect(nextLandingStep(entry({ uncommittedCount: 3, blockers: { ...none, commit: [{ code: 'run_active', message: 'A run is working' }] } }))).toBeNull();
  });

  it('offers the merge once the work is committed and the backend allows it', () => {
    expect(nextLandingStep(entry({ commitsAhead: 2 }))).toBe('merge');
  });

  it('offers nothing while the merge is refused', () => {
    expect(nextLandingStep(entry({ commitsAhead: 2, blockers: { ...none, merge: [{ code: 'main_dirty', message: 'Main has uncommitted changes' }] } }))).toBeNull();
  });

  it('offers Close for work that is already in the base branch', () => {
    expect(nextLandingStep(entry({ alreadyInBase: true }))).toBe('close');
    expect(nextLandingStep(entry({ alreadyInBase: true, blockers: { ...none, close: [{ code: 'run_active', message: 'A run is working' }] } }))).toBeNull();
  });

  it('lets ignored files alone not stop Close being offered, since its dialog lists them', () => {
    expect(nextLandingStep(entry({ alreadyInBase: true, blockers: { ...none, close: [{ code: 'ignored_files', message: 'ignored' }] } }))).toBe('close');
  });

  it('offers nothing for an untouched copy, one whose files are gone, or one without a base branch', () => {
    expect(nextLandingStep(entry())).toBeNull();
    expect(nextLandingStep(entry({ filesPresent: false, uncommittedCount: 2 }))).toBeNull();
    expect(nextLandingStep(entry({ baseBranch: null, commitsAhead: 2 }))).toBeNull();
  });
});

describe('landingStatus', () => {
  it('says one thing about where the work stands, in the tone it needs', () => {
    expect(landingStatus(entry({ uncommittedCount: 17, commitsAhead: 2 }))).toEqual({ tone: 'warning', text: '17 uncommitted files' });
    expect(landingStatus(entry({ commitsAhead: 1 }))).toEqual({ tone: 'ready', text: '1 commit ready for main' });
    expect(landingStatus(entry({ alreadyInBase: true }))).toEqual({ tone: 'ready', text: 'Already in main' });
    expect(landingStatus(entry())).toEqual({ tone: 'muted', text: 'No changes yet' });
    expect(landingStatus(entry({ filesPresent: false }))).toEqual({ tone: 'danger', text: 'Files no longer on disk' });
    expect(landingStatus(entry({ commitsAhead: 2, baseBranch: null }))).toEqual({ tone: 'ready', text: '2 commits on this branch' });
  });
});

describe('waitingReasons', () => {
  it('says what stands between committed work and the merge', () => {
    const blockers = { ...none, merge: [{ code: 'main_dirty', message: 'Main has uncommitted changes.' }, { code: 'uncommitted', message: 'Commit first.' }] };
    expect(waitingReasons(entry({ commitsAhead: 2, blockers }))).toEqual(['Main has uncommitted changes.']);
  });

  it('also says it beside uncommitted files, since committing alone will not clear it', () => {
    const blockers = { ...none, merge: [{ code: 'uncommitted', message: 'Commit first.' }, { code: 'main_dirty', message: 'Main has uncommitted changes.' }] };
    expect(waitingReasons(entry({ uncommittedCount: 1, blockers }))).toEqual(['Main has uncommitted changes.']);
  });

  it('says nothing while a run works, or when there is no work to merge', () => {
    const blockers = { ...none, merge: [{ code: 'main_dirty', message: 'Main has uncommitted changes.' }] };
    expect(waitingReasons(entry({ commitsAhead: 2, runActive: true, blockers }))).toEqual([]);
    expect(waitingReasons(entry({ blockers }))).toEqual([]);
    expect(waitingReasons(entry({ commitsAhead: 2 }))).toEqual([]);
  });
});
