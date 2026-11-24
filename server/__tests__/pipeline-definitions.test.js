import { describe, expect, it } from 'vitest';
import {
  composePrompt,
  inputFromProgressFilePath,
  isProgressFileTemplate,
  normalizeRunInput,
  runInputMode,
  validateAgentBody,
  validateRunInputField,
  validateRunStartBody,
  validateSettingsBody,
  validateStepPresetBody,
  validateTeamBody,
  validateWorkflowBody,
} from '../../shared/pipeline-definitions.mjs';

const TIMEOUTS = { agentReadySeconds: 120, resetSettleSeconds: 15, finalSignalIdleSeconds: 24, lostPromptSeconds: 30, stallWarningMinutes: 15 };

const UUID = '6f1c0000-0000-4000-8000-000000000001';
const UUID2 = '6f1c0000-0000-4000-8000-000000000002';

function fields(errors) {
  return errors.map(e => e.field);
}

describe('team member effort validation', () => {
  const member = { role: 'Developer', agentId: UUID };
  const errors = (patch, options) => fields(validateTeamBody({
    name: 'Daily', revision: 1, members: [{ ...member, ...patch }],
  }, options));

  it('accepts overrides at the length boundaries and legacy omission', () => {
    expect(errors({})).toEqual([]);
    expect(errors({ effort: 'x', fallbackAgentId: UUID2, fallbackEffort: 'x'.repeat(16) })).toEqual([]);
    expect(errors({ effort: 'x'.repeat(15) })).toEqual([]);
  });

  it.each([null, '', '  ', 1, [], {}, 'high\nlow', 'high\u2028low', 'x'.repeat(17)])('identifies each invalid effort %j', value => {
    expect(errors({ effort: value, fallbackAgentId: UUID2, fallbackEffort: value }))
      .toEqual(['members[0].effort', 'members[0].fallbackEffort']);
  });

  it('requires a fallback for fallback effort and rejects unknown fields', () => {
    expect(errors({ fallbackEffort: 'high' })).toEqual(['members[0].fallbackEffort']);
    expect(errors({ otherEffort: 'high' })).toEqual(['members[0]']);
  });

  it('accepts explicit clears only for an update', () => {
    expect(errors({ effort: null, fallbackEffort: null }, { revisionRequired: true })).toEqual([]);
  });
});

describe('team role fallback validation', () => {
  const team = members => ({ name: 'Daily', members, revision: 1 });
  const developer = { role: 'Developer', agentId: UUID };

  it('accepts omission, null clear, and distinct fallback UUIDs shared across roles', () => {
    for (const member of [developer, { ...developer, fallbackAgentId: null }, { ...developer, fallbackAgentId: UUID2 }]) {
      expect(validateTeamBody(team([member, { role: 'Reviewer', agentId: UUID, fallbackAgentId: UUID2 }]), { revisionRequired: true })).toEqual([]);
    }
  });

  it.each(['', [], {}, 1, '"; DROP TABLE pipeline_teams;', UUID, UUID.toUpperCase()])('rejects invalid or self fallback %j', fallbackAgentId => {
    expect(fields(validateTeamBody(team([{ ...developer, fallbackAgentId }])))).toEqual(['members[0].fallbackAgentId']);
  });

  it('reports unknown team and member keys without reflecting a hostile field name', () => {
    const errors = validateTeamBody({ ...team([{ ...developer, '<script>': 'x' }]), '<script>': 'x' });
    expect(fields(errors)).toEqual(['body', 'members[0]']);
  });
});

describe('validateAgentBody', () => {
  const valid = { name: 'codex-sol', launchCommand: 'codex --model gpt', resetCommand: '/clear' };

  it('accepts a valid agent', () => {
    expect(validateAgentBody(valid)).toEqual([]);
  });

  it('rejects unknown fields', () => {
    expect(fields(validateAgentBody({ ...valid, extra: 1 }))).toContain('extra');
  });

  it('rejects missing and blank name', () => {
    expect(fields(validateAgentBody({ ...valid, name: '' }))).toContain('name');
    expect(fields(validateAgentBody({ ...valid, name: '   ' }))).toContain('name');
  });

  it('rejects name outside 1–64 after trim', () => {
    expect(validateAgentBody({ ...valid, name: 'x' })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, name: 'x'.repeat(65) }))).toContain('name');
    expect(validateAgentBody({ ...valid, name: 'x'.repeat(64) })).toEqual([]);
  });

  it('rejects control characters in name (single-line)', () => {
    expect(fields(validateAgentBody({ ...valid, name: 'a\nb' }))).toContain('name');
    expect(fields(validateAgentBody({ ...valid, name: 'a\tb' }))).toContain('name');
  });

  it('rejects launchCommand outside 1–2048 or with controls', () => {
    expect(fields(validateAgentBody({ ...valid, launchCommand: '' }))).toContain('launchCommand');
    expect(fields(validateAgentBody({ ...valid, launchCommand: '   ' }))).toContain('launchCommand');
    expect(fields(validateAgentBody({ ...valid, launchCommand: 'x'.repeat(2049) }))).toContain('launchCommand');
    expect(validateAgentBody({ ...valid, launchCommand: 'x'.repeat(2048) })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, launchCommand: 'a\nb' }))).toContain('launchCommand');
  });

  it('rejects resetCommand outside 1–256 or with controls', () => {
    expect(fields(validateAgentBody({ ...valid, resetCommand: '' }))).toContain('resetCommand');
    expect(fields(validateAgentBody({ ...valid, resetCommand: 'x'.repeat(257) }))).toContain('resetCommand');
    expect(validateAgentBody({ ...valid, resetCommand: 'x'.repeat(256) })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, resetCommand: 'a\nb' }))).toContain('resetCommand');
  });

  it('requires integer revision ≥ 1 when present', () => {
    expect(validateAgentBody({ ...valid, revision: 1 })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, revision: 0 }))).toContain('revision');
    expect(fields(validateAgentBody({ ...valid, revision: 1.5 }))).toContain('revision');
  });
});

describe('workflow progress file', () => {
  const body = progressFile => ({ name: 'Feature', agentsDecide: false, nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Work', repeat: { mode: 'once' } }], progressFile });
  const valid = ['docs/{input}', '{input}', 'docs/{input}.md', 'docs/todos/{input}', 'docs/todo.md', 'docs/{input}.MD', 'a'.repeat(297) + '.md', 'a'.repeat(290) + '{input}.md'];
  const invalid = ['', ' ', 1, {}, [], 'docs/{input}/notes', '/{input}', '~/{input}', '{input}/../x.md', 'docs//{input}', 'docs/{input}.txt', 'docs\\{input}', 'a'.repeat(301), '/tmp/todo.md', '~/todo.md', 'a\\b.md', '../todo.md', 'a/../b.md', 'a//b.md', 'a\nb.md', 'a\u0085b.md', 'a\u2028b.md', 'todo.txt', 'a'.repeat(298) + '.md'];
  it.each(valid)('accepts %s', progressFile => {
    expect(validateWorkflowBody(body(progressFile))).toEqual([]);
  });
  it.each(invalid)('rejects %s', progressFile => {
    expect(validateWorkflowBody(body(progressFile)).map(error => error.field)).toContain('progressFile');
  });
  it.each(valid)('recognizes template %s', value => {
    expect(isProgressFileTemplate(value)).toBe(true);
  });
  it.each(invalid.filter(value => value !== ' '))('rejects template %s', value => {
    expect(isProgressFileTemplate(value)).toBe(false);
  });
  it('accepts absent and null', () => {
    expect(validateWorkflowBody(body(null))).toEqual([]);
    const without = body(null); delete without.progressFile;
    expect(validateWorkflowBody(without)).toEqual([]);
  });
});

describe('validateWorkflowBody', () => {
  const node = (overrides = {}) => ({
    name: 'Develop',
    role: 'Developer',
    prompt: 'do {input}',
    repeat: { mode: 'once' },
    ...overrides,
  });
  const valid = { name: 'Feature', agentsDecide: false, nodes: [node()] };

  it('validates both optional node flags and forbids approval on a loop closer', () => {
    for (const flag of ['readOnly', 'approval']) {
      expect(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: true })] })).toEqual([]);
      expect(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: false })] })).toEqual([]);
      for (const value of [null, 0, 'true']) {
        expect(fields(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: value })] }))).toContain(`nodes[0].${flag}`);
      }
    }
    const nodes = [node({ name: 'Analyse', approval: true }), node({ name: 'Review', repeat: { mode: 'loop_back', to: 'Analyse', max: 2 }, approval: true })];
    expect(fields(validateWorkflowBody({ ...valid, nodes }))).toContain('nodes[1].approval');
    expect(validateWorkflowBody({ ...valid, nodes: [{ ...nodes[0], repeat: { mode: 'until_complete', max: 2 } }, { ...nodes[1], approval: false }] })).toEqual([]);
  });
  it.each([{ mode: 'once' }, { mode: 'until_complete', max: 2 }])('accepts approval on a %j node', repeat => {
    expect(validateWorkflowBody({ ...valid, nodes: [node({ repeat, approval: true })] })).toEqual([]);
  });
  it('accepts approval on a non-closing node inside a loop', () => {
    expect(validateWorkflowBody({ ...valid, nodes: [
      node({ name: 'Analyse', approval: true }),
      node({ name: 'Review', repeat: { mode: 'loop_back', to: 'Analyse', max: 2 } }),
    ] })).toEqual([]);
  });
  it.each(['readOnly', 'approval'])('names %s for every wrong node flag type', flag => {
    for (const bad of [null, 0, 1, 'true', [], {}]) {
      expect(fields(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: bad })] }))).toContain(`nodes[0].${flag}`);
    }
  });

  it('accepts a valid workflow', () => {
    expect(validateWorkflowBody(valid)).toEqual([]);
  });

  it('rejects unknown top-level and node fields', () => {
    expect(fields(validateWorkflowBody({ ...valid, extra: 1 }))).toContain('extra');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [{ ...node(), extra: true }],
    }))).toContain('nodes[0].extra');
  });

  it('requires 1–32 nodes', () => {
    expect(fields(validateWorkflowBody({ name: 'Feature', agentsDecide: false, nodes: [] }))).toContain('nodes');
    expect(fields(validateWorkflowBody({ name: 'Feature', agentsDecide: false, nodes: null }))).toContain('nodes');
    const thirtyTwo = Array.from({ length: 32 }, (_, i) => node({ name: `N${i}` }));
    expect(validateWorkflowBody({ name: 'Feature', agentsDecide: false, nodes: thirtyTwo })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [...thirtyTwo, node({ name: 'N32' })],
    }))).toContain('nodes');
  });

  it('rejects duplicate node names case-insensitively', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ name: 'Dev' }), node({ name: 'dev' })],
    }))).toContain('nodes[1].name');
  });

  it('rejects workflow-level agent assignment', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ agentId: 'not-a-uuid' })],
    }))).toContain('nodes[0].agentId');
  });

  it('rejects prompt outside 1–8192 or with forbidden controls', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: '' })],
    }))).toContain('nodes[0].prompt');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: 'x'.repeat(8193) })],
    }))).toContain('nodes[0].prompt');
    expect(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: 'line1\nline2\tok' })],
    })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: 'bad\x00' })],
    }))).toContain('nodes[0].prompt');
  });

  it('rejects max with once and missing max with until_complete', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'once', max: 1 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete' } })],
    }))).toContain('nodes[0].repeat.max');
  });

  it('accepts until_complete max at 1 and 100; rejects 0 and 101 and non-integers', () => {
    expect(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 1 } })],
    })).toEqual([]);
    expect(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 100 } })],
    })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 0 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 101 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 1.5 } })],
    }))).toContain('nodes[0].repeat.max');
  });
});

describe('validateSettingsBody', () => {
  const timeouts = { agentReadySeconds: 120, resetSettleSeconds: 15, finalSignalIdleSeconds: 24, lostPromptSeconds: 30, stallWarningMinutes: 15 };
  it('requires and validates every timeout field', () => {
    const body = { setupAgentId: null, defaultBaseBranch: null, revision: 1, timeouts };
    expect(validateSettingsBody(body)).toEqual([]);
    expect(fields(validateSettingsBody({ ...body, timeouts: undefined }))).toContain('timeouts');
    expect(fields(validateSettingsBody({ ...body, timeouts: { ...timeouts, extra: 1 } }))).toContain('timeouts.extra');
    expect(fields(validateSettingsBody({ ...body, timeouts: { ...timeouts, toString: 1 } }))).toContain('timeouts.toString');
    for (const [field, min, max] of [['agentReadySeconds', 10, 3600], ['resetSettleSeconds', 5, 600], ['finalSignalIdleSeconds', 5, 600], ['lostPromptSeconds', 5, 600], ['stallWarningMinutes', 1, 240]]) {
      for (const value of [min - 1, max + 1, 1.5, undefined]) {
        expect(fields(validateSettingsBody({ ...body, timeouts: { ...timeouts, [field]: value } }))).toContain(`timeouts.${field}`);
      }
    }
  });
  it('accepts null or UUID setupAgentId with revision', () => {
    expect(validateSettingsBody({ setupAgentId: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 })).toEqual([]);
    expect(validateSettingsBody({ setupAgentId: UUID, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 2 })).toEqual([]);
  });

  it('accepts a branch name or null as the default base branch, and requires it', () => {
    expect(validateSettingsBody({ setupAgentId: null, defaultBaseBranch: 'develop', timeouts: TIMEOUTS, revision: 1 })).toEqual([]);
    expect(validateSettingsBody({ setupAgentId: null, defaultBaseBranch: 'release/2.1', timeouts: TIMEOUTS, revision: 1 })).toEqual([]);
    for (const bad of ['', ' develop', '-x', 'a b', 'a..b', 'x.lock', 'x/', '/x', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '@', 'a@{b', 'x'.repeat(201), 3, undefined]) {
      expect(fields(validateSettingsBody({ setupAgentId: null, defaultBaseBranch: bad, timeouts: TIMEOUTS, revision: 1 }))).toContain('defaultBaseBranch');
    }
  });

  it('rejects invalid setupAgentId and revision', () => {
    expect(fields(validateSettingsBody({ setupAgentId: 'x', defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 }))).toContain('setupAgentId');
    expect(fields(validateSettingsBody({ setupAgentId: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 0 }))).toContain('revision');
  });

  it('rejects unknown fields', () => {
    expect(fields(validateSettingsBody({ setupAgentId: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1, extra: 1 }))).toContain('extra');
  });
});

describe('run input modes and normalization', () => {
  it('treats templated Progress files as path input and everything else as descriptive', () => {
    expect(runInputMode('docs/{input}')).toBe('path');
    expect(runInputMode('{input}')).toBe('path');
    expect(runInputMode('docs/todo.md')).toBe('descriptive');
    expect(runInputMode(null)).toBe('descriptive');
    expect(runInputMode(undefined)).toBe('descriptive');
  });

  it('normalizes CRLF and lone CR to LF before validation', () => {
    expect(normalizeRunInput('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizeRunInput('already\nfine')).toBe('already\nfine');
  });

  it('accepts descriptive paragraphs, blank lines and exact 4096 after normalization', () => {
    expect(validateRunInputField('first\n\nsecond', { mode: 'descriptive' })).toBeNull();
    expect(validateRunInputField('a\r\nb', { mode: 'descriptive' })).toBeNull();
    expect(validateRunInputField('x'.repeat(4096), { mode: 'descriptive' })).toBeNull();
    expect(validateRunInputField(`${'x'.repeat(4095)}\r`, { mode: 'descriptive' })).toBeNull();
    expect(validateRunInputField('', { mode: 'descriptive' })).toBeNull();
  });

  it('rejects descriptive missing, null, wrong type, controls, and one over 4096', () => {
    for (const input of [undefined, null, 12, {}, []]) {
      expect(validateRunInputField(input, { mode: 'descriptive' })).toMatch(/4096/);
    }
    expect(validateRunInputField('x'.repeat(4097), { mode: 'descriptive' })).toMatch(/4096/);
    expect(validateRunInputField('a\0b', { mode: 'descriptive' })).toMatch(/control/i);
    expect(validateRunInputField('a\x1bb', { mode: 'descriptive' })).toMatch(/control/i);
    expect(validateRunInputField('a\tb', { mode: 'descriptive' })).toMatch(/control/i);
  });

  it('keeps path input on one line without control characters', () => {
    expect(validateRunInputField('docs/todos/x.md', { mode: 'path' })).toBeNull();
    expect(validateRunInputField('a\nb', { mode: 'path' })).toMatch(/one line/i);
    expect(validateRunInputField('a\r\nb', { mode: 'path' })).toMatch(/one line/i);
    expect(validateRunInputField('a\0b', { mode: 'path' })).toMatch(/one line/i);
    expect(validateRunInputField('x'.repeat(4097), { mode: 'path' })).toMatch(/4096/);
  });
});

describe('validateRunStartBody', () => {
  const valid = {
    requestId: 'run-3f2a9c',
    workflowId: UUID,
    project: 'codedeck',
    input: 'docs/todos/x.md',
    teamId: UUID2,
  };

  it('requires a team for a new start, but not when reading back an older reservation', () => {
    const legacy = { ...valid }; delete legacy.teamId;
    expect(fields(validateRunStartBody(legacy))).toContain('teamId');
    expect(fields(validateRunStartBody(legacy, { requireTeam: false }))).not.toContain('teamId');
  });

  it('accepts a valid body including empty input', () => {
    expect(validateRunStartBody(valid)).toEqual([]);
    expect(validateRunStartBody({ ...valid, input: '' })).toEqual([]);
  });

  it('accepts descriptive multiline input by default and rejects it in path mode', () => {
    expect(validateRunStartBody({ ...valid, input: 'first\n\nsecond paragraph' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, input: 'a\r\nb' })).toEqual([]);
    expect(fields(validateRunStartBody({ ...valid, input: 'a\nb' }, { inputMode: 'path' }))).toContain('input');
  });

  it('rejects bad requestId, workflowId, project and input bounds', () => {
    expect(fields(validateRunStartBody({ ...valid, requestId: '' }))).toContain('requestId');
    expect(fields(validateRunStartBody({ ...valid, requestId: 'bad id' }))).toContain('requestId');
    expect(fields(validateRunStartBody({ ...valid, workflowId: 'nope' }))).toContain('workflowId');
    expect(fields(validateRunStartBody({ ...valid, project: '' }))).toContain('project');
    expect(fields(validateRunStartBody({ ...valid, input: 'x'.repeat(4097) }))).toContain('input');
    expect(fields(validateRunStartBody({ ...valid, input: 'a\0b' }))).toContain('input');
    expect(fields(validateRunStartBody({ ...valid, input: null }))).toContain('input');
  });

  it('accepts a run in an existing task or in a task created for it', () => {
    expect(validateRunStartBody({ ...valid, taskId: UUID2 })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: { title: 'x' } })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: { title: 'x'.repeat(80) } })).toEqual([]);
  });

  it('rejects a bad task, a bad new task and more than one place to run', () => {
    expect(fields(validateRunStartBody({ ...valid, taskId: 'nope' }))).toEqual(['taskId']);
    expect(fields(validateRunStartBody({ ...valid, taskId: null }))).toEqual(['taskId']);
    // A new task needs no title: one that is absent is made from the input and named later.
    expect(validateRunStartBody({ ...valid, newTask: {} })).toEqual([]);
    for (const newTask of [null, 'x', [], { title: null }, { title: '' }, { title: '  ' }, { title: 12 }, { title: 'x'.repeat(81) }, { title: 'a\nb' }]) {
      expect(fields(validateRunStartBody({ ...valid, newTask }))[0]).toMatch(/^newTask/);
    }
    expect(fields(validateRunStartBody({ ...valid, newTask: { title: 'x', branch: 'y' } }))).toEqual(['newTask.branch']);
    expect(fields(validateRunStartBody({ ...valid, taskId: UUID2, newTask: { title: 'x' } }))).toEqual(['newTask']);
    expect(fields(validateRunStartBody({ ...valid, worktreePath: '/tmp/w', taskId: UUID2 }))).toEqual(['taskId']);
  });

  it('rejects unknown fields', () => {
    expect(fields(validateRunStartBody({ ...valid, extra: 1 }))).toContain('extra');
  });

  it('accepts a base branch for a new task and refuses one that is not a branch name', () => {
    expect(validateRunStartBody({ ...valid, newTask: { baseBranch: 'develop' } })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: { title: 'x', baseBranch: 'release/2.1' } })).toEqual([]);
    for (const baseBranch of ['', '-x', 'a b', 'a..b', null, 5]) {
      expect(fields(validateRunStartBody({ ...valid, newTask: { baseBranch } }))).toEqual(['newTask.baseBranch']);
    }
  });

  it('accepts the repositories of a new task and the one a run starts in', () => {
    expect(validateRunStartBody({ ...valid, newTask: { repositories: ['mobile-app', 'backend'] }, startIn: 'mobile-app' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: { title: 'x', repositories: ['backend'] } })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: {}, startIn: 'mobile-app' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, taskId: UUID2, startIn: 'mobile-app' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: { repositories: Array.from({ length: 9 }, (_, index) => `r${index}`) } })).toEqual([]);
  });

  it('rejects a bad list of repositories and a bad or misplaced start repository', () => {
    for (const repositories of [null, 'backend', [], [''], [7], ['a/b'], ['..'], ['backend', 'backend'], ['x'.repeat(101)], Array.from({ length: 10 }, (_, index) => `r${index}`)]) {
      expect(fields(validateRunStartBody({ ...valid, newTask: { repositories } }))).toEqual(['newTask.repositories']);
    }
    for (const startIn of [null, '', 7, 'a/b', '..', 'x'.repeat(101), 'two\nlines']) {
      expect(fields(validateRunStartBody({ ...valid, taskId: UUID2, startIn }))).toEqual(['startIn']);
    }
    // The repository a run starts in must be one the new task includes.
    expect(validateRunStartBody({ ...valid, newTask: { repositories: ['backend'] }, startIn: 'mobile-app' }))
      .toEqual([{ field: 'startIn', message: 'Use one of the repositories the new task includes' }]);
    // A run in a worktree named by path works there; it has no repository to start in.
    expect(validateRunStartBody({ ...valid, worktreePath: '/tmp/w', startIn: 'backend' }))
      .toEqual([{ field: 'startIn', message: 'Use it with a task; a run in a worktree named by path works in that worktree' }]);
    expect(validateRunStartBody({ ...valid, startIn: 'backend' }))
      .toEqual([{ field: 'startIn', message: 'Use it with a task; a run in a worktree named by path works in that worktree' }]);
  });

  it('accepts an absolute worktreePath of 1–4096 characters, or none', () => {
    expect(validateRunStartBody({ ...valid, worktreePath: '/Users/me/git/worktrees/codedeck-x' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, worktreePath: '/' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, worktreePath: `/${'a'.repeat(4095)}` })).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a number', 5],
    ['an array', ['/a']],
    ['an empty string', ''],
    ['a relative path', 'worktrees/x'],
    ['a newline', '/a\nb'],
    ['a NUL byte', '/a\u0000b'],
    ['4097 characters', `/${'a'.repeat(4096)}`],
  ])('rejects a worktreePath that is %s', (_label, worktreePath) => {
    expect(validateRunStartBody({ ...valid, worktreePath })).toEqual([
      { field: 'worktreePath', message: 'Use the absolute path of an existing worktree, 1–4096 characters on one line, or leave it out for a new worktree' },
    ]);
  });
});

describe('inputFromProgressFilePath', () => {
  it('reads the part that replaces {input} from the whole path of the progress file', () => {
    expect(inputFromProgressFilePath('docs/{input}', 'docs/todos/2026-11-19-093544-tag-pings.md')).toBe('todos/2026-11-19-093544-tag-pings.md');
    expect(inputFromProgressFilePath('docs/todos/{input}.md', 'docs/todos/feature.md')).toBe('feature');
    expect(inputFromProgressFilePath('{input}.md', 'plan.md')).toBe('plan');
    // The part composes back to exactly what was typed.
    expect(composePrompt('docs/{input}', inputFromProgressFilePath('docs/{input}', 'docs/docs/x.md'))).toBe('docs/docs/x.md');
  });

  it.each([
    ['an input that is only the part', 'docs/{input}', 'todos/plan.md'],
    ['an input that is the fixed text and nothing more', 'docs/{input}.md', 'docs/.md'],
    ['an input shorter than the fixed text around the part', 'docs/a{input}a.md', 'docs/a.md'],
    ['a template that is all input', '{input}', 'docs/todos/plan.md'],
    ['a template without {input}', 'docs/todo.md', 'docs/todo.md'],
    ['a template that uses {input} twice', 'docs/{input}/{input}.md', 'docs/a/a.md'],
    ['another ending', 'docs/{input}.md', 'docs/todos/plan.txt'],
    ['a prefix of other letter case', 'docs/{input}', 'Docs/todos/plan.md'],
  ])('answers null for %s', (_name, template, input) => {
    expect(inputFromProgressFilePath(template, input)).toBeNull();
  });

  it.each([
    ['template', [null, 'docs/todos/plan.md'], 'progress file template must be a string'],
    ['template', [undefined, 'docs/todos/plan.md'], 'progress file template must be a string'],
    ['input', ['docs/{input}', undefined], 'input must be a string'],
    ['input', ['docs/{input}', 12], 'input must be a string'],
  ])('refuses a %s that is not text', (_name, args, message) => {
    expect(() => inputFromProgressFilePath(...args)).toThrow(message);
  });
});

describe('composePrompt', () => {
  it('replaces every {input} in a single pass', () => {
    expect(composePrompt('do {input} and {input}', 'A')).toBe('do A and A');
  });

  it('does not re-expand {input} that came from the input value', () => {
    expect(composePrompt('do {input}', 'contains {input} literally')).toBe('do contains {input} literally');
  });

  it('inserts input literally without interpreting replacement tokens', () => {
    expect(composePrompt('the {input} regex', '$&')).toBe('the $& regex');
    expect(composePrompt('keep {input}', '$$ $` $\'')).toBe('keep $$ $` $\'');
  });

  it('enforces the 16384 composed length limit when checking', () => {
    const prompt = 'x'.repeat(16384);
    expect(composePrompt(prompt, '')).toBe(prompt);
    const errors = [];
    const composed = composePrompt('{input}', 'y'.repeat(16385), errors, 'input');
    expect(composed.length).toBe(16385);
    expect(fields(errors)).toContain('input');
  });
});

describe('validateWorkflowBody: who decides', () => {
  const node = { name: 'Develop', role: 'Developer', prompt: 'do {input}', repeat: { mode: 'once' } };

  it.each([true, false])('accepts agentsDecide %s', (agentsDecide) => {
    expect(validateWorkflowBody({ name: 'Feature', agentsDecide, nodes: [node] })).toEqual([]);
  });

  it.each([undefined, null, 'true', 1, 0])('rejects agentsDecide %s', (agentsDecide) => {
    expect(validateWorkflowBody({ name: 'Feature', agentsDecide, nodes: [node] })).toEqual([
      { field: 'agentsDecide', message: 'Use true or false' },
    ]);
  });
});

describe('validateWorkflowBody: looping back to an earlier node', () => {
  const node = (name, repeat = { mode: 'once' }) => ({ name, role: 'Developer', prompt: 'do {input}', repeat });
  const loop = (to, max = 20) => ({ mode: 'loop_back', to, max });
  const workflow = (...nodes) => ({ name: 'Feature', agentsDecide: false, nodes });

  it('accepts a loop back to an earlier node, matched by name whatever its case or padding', () => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', loop('Develop')), node('Review')))).toEqual([]);
    expect(validateWorkflowBody(workflow(node('Develop'), node('Review'), node('Test', loop(' develop '))))).toEqual([]);
  });

  it('accepts a repeating node inside a loop and two loops that share no node', () => {
    expect(validateWorkflowBody(workflow(
      node('Develop', { mode: 'until_complete', max: 3 }), node('Test', loop('Develop')),
      node('Review'), node('Fix', loop('Review')),
    ))).toEqual([]);
  });

  it.each([1, 100])('accepts a maximum of %i rounds', (max) => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', loop('Develop', max))))).toEqual([]);
  });

  it.each([0, 101, 1.5, '5', undefined, null])('rejects a maximum of %s rounds', (max) => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', { mode: 'loop_back', to: 'Develop', max })))).toEqual([
      { field: 'nodes[1].repeat.max', message: 'Use a whole number from 1 to 100' },
    ]);
  });

  it.each([
    ['itself', 'Test'],
    ['a later node', 'Review'],
    ['a node that does not exist', 'Deploy'],
    ['a blank name', '  '],
    ['a number', 7],
    ['nothing', undefined],
  ])('rejects a loop back to %s', (_label, to) => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', { mode: 'loop_back', to, max: 5 }), node('Review')))).toEqual([
      { field: 'nodes[1].repeat.to', message: 'Choose an earlier node to loop back to' },
    ]);
  });

  it('rejects a loop on the first node, which has no earlier node', () => {
    expect(fields(validateWorkflowBody(workflow(node('Develop', loop('Develop')))))).toEqual(['nodes[0].repeat.to']);
  });

  it('rejects loops that share a node, nested or crossing', () => {
    const message = 'Loops cannot share a node; this one overlaps the loop that ends at Test';
    expect(validateWorkflowBody(workflow(
      node('Plan'), node('Develop'), node('Test', loop('Develop')), node('Review', loop('Plan')),
    ))).toEqual([{ field: 'nodes[3].repeat.to', message }]);
    expect(validateWorkflowBody(workflow(
      node('Plan'), node('Develop'), node('Test', loop('Plan')), node('Review', loop('Develop')),
    ))).toEqual([{ field: 'nodes[3].repeat.to', message }]);
  });

  it('rejects unknown repeat fields and names the three modes', () => {
    expect(fields(validateWorkflowBody(workflow(node('Develop'), node('Test', { ...loop('Develop'), extra: 1 }))))).toEqual(['nodes[1].repeat.extra']);
    expect(fields(validateWorkflowBody(workflow(node('Develop', { mode: 'once', to: 'Develop' }))))).toEqual(['nodes[0].repeat.to']);
    expect(fields(validateWorkflowBody(workflow(node('Develop', { mode: 'until_complete', max: 2, to: 'Develop' }))))).toEqual(['nodes[0].repeat.to']);
    expect(validateWorkflowBody(workflow(node('Develop', { mode: 'forever' })))).toEqual([
      { field: 'nodes[0].repeat.mode', message: 'Choose once, until_complete or loop_back' },
    ]);
  });
});

describe('workflow kind, description and step roles', () => {
  const node = (extra = {}) => ({ name: 'Develop', role: 'Developer', prompt: 'Build', repeat: { mode: 'once' }, ...extra });
  const body = (extra = {}) => ({ name: 'Feature', agentsDecide: false, nodes: [node()], ...extra });

  it('accepts workflow metadata and a named role', () => {
    expect(validateWorkflowBody(body())).toEqual([]);
    expect(validateWorkflowBody(body({ kind: 'troubleshoot', description: 'x'.repeat(280), nodes: [node({ role: 'x'.repeat(32) })] }))).toEqual([]);
    expect(validateWorkflowBody(body({ description: '' }))).toEqual([]);
  });

  it.each([
    [{ kind: 'deploy' }, 'kind'], [{ kind: null }, 'kind'], [{ kind: 12 }, 'kind'],
    [{ description: 'x'.repeat(281) }, 'description'], [{ description: 'a\nb' }, 'description'], [{ description: null }, 'description'], [{ description: 12 }, 'description'],
  ])('rejects %j', (extra, field) => {
    expect(fields(validateWorkflowBody(body(extra)))).toEqual([field]);
  });

  it.each([['x'.repeat(33)], ['a\nb'], [null], [12]])('rejects the role %j', role => {
    expect(fields(validateWorkflowBody(body({ nodes: [node({ role })] })))).toEqual(['nodes[0].role']);
  });

  it('validates a saved template with the same role-only nodes as a workflow', () => {
    const step = node();
    expect(validateWorkflowBody(body({ nodes: [step] }), { template: true })).toEqual([]);
    expect(validateWorkflowBody(body({ nodes: [step] }))).toEqual([]);
    expect(fields(validateWorkflowBody(body({ nodes: [{ ...step, agentId: UUID }] }), { template: true }))).toEqual(['nodes[0].agentId']);
    expect(fields(validateWorkflowBody(body({ nodes: [{ ...step, prompt: '' }] }), { template: true }))).toEqual(['nodes[0].prompt']);
  });
});

describe('validateStepPresetBody', () => {
  const valid = { name: 'Review', role: 'Reviewer', prompt: 'Review the changes', repeat: { mode: 'once' }, readOnly: true, approval: false };

  it('accepts a step with or without its options, and a bounded repeat', () => {
    expect(validateStepPresetBody(valid)).toEqual([]);
    expect(validateStepPresetBody({ name: 'x', role: 'Reviewer', prompt: 'p', repeat: { mode: 'until_complete', max: 100 } })).toEqual([]);
    expect(validateStepPresetBody({ ...valid, name: 'x'.repeat(64), prompt: 'x'.repeat(8192) })).toEqual([]);
  });

  it.each([
    [{ name: '' }, 'name'], [{ name: 'x'.repeat(65) }, 'name'], [{ name: null }, 'name'],
    [{ role: 'x'.repeat(33) }, 'role'], [{ role: 12 }, 'role'],
    [{ prompt: '' }, 'prompt'], [{ prompt: '  ' }, 'prompt'], [{ prompt: 'x'.repeat(8193) }, 'prompt'], [{ prompt: 'a\u0007b' }, 'prompt'], [{ prompt: null }, 'prompt'],
    [{ repeat: { mode: 'loop_back', to: 'Develop', max: 3 } }, 'repeat.mode'], [{ repeat: { mode: 'sometimes' } }, 'repeat.mode'],
    [{ repeat: { mode: 'until_complete', max: 0 } }, 'repeat.max'], [{ repeat: { mode: 'until_complete', max: 101 } }, 'repeat.max'], [{ repeat: null }, 'repeat'],
    [{ readOnly: 'yes' }, 'readOnly'], [{ approval: 1 }, 'approval'], [{ agentId: UUID }, 'agentId'],
  ])('rejects %j', (extra, field) => {
    expect(fields(validateStepPresetBody({ ...valid, ...extra }))).toEqual([field]);
  });

  it('requires a revision only when asked, and an object', () => {
    expect(fields(validateStepPresetBody(valid, { revisionRequired: true }))).toEqual(['revision']);
    expect(validateStepPresetBody({ ...valid, revision: 2 }, { revisionRequired: true })).toEqual([]);
    expect(fields(validateStepPresetBody([]))).toEqual(['body']);
  });
});

describe('a step that always asks the owner', () => {
  const node = (extra = {}) => ({ name: 'Clarify', role: 'Developer', prompt: 'Ask', repeat: { mode: 'once' }, ...extra });
  it('is accepted on a workflow node, a template node and a saved step, and must be a boolean', () => {
    expect(validateWorkflowBody({ name: 'W', agentsDecide: true, nodes: [node({ askOwner: true })] })).toEqual([]);
    const templateNode = node({ askOwner: true });
    expect(validateWorkflowBody({ name: 'W', agentsDecide: true, nodes: [templateNode] }, { template: true })).toEqual([]);
    expect(validateStepPresetBody({ name: 'Clarify', role: 'Developer', prompt: 'Ask', repeat: { mode: 'once' }, askOwner: true })).toEqual([]);
    expect(fields(validateWorkflowBody({ name: 'W', agentsDecide: true, nodes: [node({ askOwner: 'yes' })] }))).toEqual(['nodes[0].askOwner']);
    expect(fields(validateStepPresetBody({ name: 'Clarify', role: 'Developer', prompt: 'Ask', repeat: { mode: 'once' }, askOwner: 1 }))).toEqual(['askOwner']);
  });
});

describe('disabling a stage in a workflow or run start', () => {
  const node = (name, extra = {}) => ({ name, role: 'Developer', prompt: 'Do work', repeat: { mode: 'once' }, ...extra });

  it('accepts enabled boolean on nodes, requires at least one enabled node, and forbids looping back to a disabled node', () => {
    expect(validateWorkflowBody({
      name: 'W',
      agentsDecide: false,
      nodes: [node('Requirements', { enabled: false }), node('Develop', { enabled: true })],
    })).toEqual([]);
    expect(validateWorkflowBody({
      name: 'W',
      agentsDecide: false,
      nodes: [node('Requirements', { enabled: false })],
    })).toEqual([{ field: 'nodes', message: 'Enable at least one node' }]);
    expect(validateWorkflowBody({
      name: 'W',
      agentsDecide: false,
      nodes: [
        node('Develop', { enabled: false }),
        node('Test', { repeat: { mode: 'loop_back', to: 'Develop', max: 3 } }),
      ],
    })).toEqual([
      { field: 'nodes[1].repeat.to', message: 'Choose an enabled earlier node to loop back to' },
    ]);
    expect(fields(validateWorkflowBody({
      name: 'W',
      agentsDecide: false,
      nodes: [node('Develop', { enabled: 'no' })],
    }))).toEqual(['nodes[0].enabled']);
  });

  it('validates disabledSteps on validateRunStartBody', () => {
    const valid = { requestId: 'run-1', workflowId: UUID, project: 'codedeck', input: 'x', teamId: UUID2 };
    expect(validateRunStartBody({ ...valid, disabledSteps: [] })).toEqual([]);
    expect(validateRunStartBody({ ...valid, disabledSteps: ['Requirements', 'Review'] })).toEqual([]);
    expect(fields(validateRunStartBody({ ...valid, disabledSteps: 'Requirements' }))).toEqual(['disabledSteps']);
    expect(fields(validateRunStartBody({ ...valid, disabledSteps: [''] }))).toEqual(['disabledSteps']);
    expect(fields(validateRunStartBody({ ...valid, disabledSteps: ['Review', 'review'] }))).toEqual(['disabledSteps']);
  });
});
