import { describe, expect, it } from 'vitest';
import { parseTodoRepositories, TODO_REPOSITORIES_MAX } from '../../shared/todo-repositories.mjs';

const todo = line => `# Tag pings\n\n**Spec**: \`docs/specifications/tag-pings-spec.md\`\n${line}\n**Status**: Not started\n\n## Phase 1: Models\n- [ ] One\n`;

describe('parseTodoRepositories', () => {
  it('reads which repositories a todo touches and how', () => {
    expect(parseTodoRepositories(todo('**Repositories**: backend (this todo), mobile-app (docs/todos/tag-pings-phone.md), frontend (minor)'))).toEqual({
      found: true,
      problem: null,
      entries: [
        { repository: 'backend', role: 'this', todo: null },
        { repository: 'mobile-app', role: 'todo', todo: 'docs/todos/tag-pings-phone.md' },
        { repository: 'frontend', role: 'minor', todo: null },
      ],
    });
  });

  it('takes a middle dot between entries, extra spaces, and a path in backticks', () => {
    expect(parseTodoRepositories(todo('**Repositories**:   backend (this todo) ·  mobile-app ( `docs/todos/phone.md` )  ·frontend(minor)')).entries).toEqual([
      { repository: 'backend', role: 'this', todo: null },
      { repository: 'mobile-app', role: 'todo', todo: 'docs/todos/phone.md' },
      { repository: 'frontend', role: 'minor', todo: null },
    ]);
  });

  it('says nothing was found when the todo has no such line before its first section', () => {
    expect(parseTodoRepositories('# Plan\n\n**Status**: Not started\n\n## Phase 1\n- [ ] One\n')).toEqual({ found: false, problem: null, entries: [] });
    expect(parseTodoRepositories('')).toEqual({ found: false, problem: null, entries: [] });
    // A line of the same shape inside a phase is the work's own text, not the header.
    expect(parseTodoRepositories('# Plan\n\n## Phase 1\n**Repositories**: backend (minor)\n').found).toBe(false);
  });

  it.each([
    ['nothing after the colon', '**Repositories**:', 'names no repository'],
    ['an entry without a role', '**Repositories**: backend, frontend (minor)', 'Write each repository as name (this todo), name (minor) or name (path/to/its-todo.md)'],
    ['text between entries', '**Repositories**: backend (this todo) and frontend (minor)', 'Write each repository as name (this todo), name (minor) or name (path/to/its-todo.md)'],
    ['an unknown role', '**Repositories**: backend (major)', 'backend (major): use this todo, minor, or the path of a .md file'],
    ['a role left empty', '**Repositories**: backend ()', 'backend (): use this todo, minor, or the path of a .md file'],
    ['a path that leaves the repository', '**Repositories**: backend (../other/todo.md)', 'backend (../other/todo.md): use this todo, minor, or the path of a .md file'],
    ['a full path from disk', '**Repositories**: backend (/Users/me/todo.md)', 'backend (/Users/me/todo.md): use this todo, minor, or the path of a .md file'],
    ['a name that is not a folder name', '**Repositories**: back/end (minor)', 'Write each repository as name (this todo), name (minor) or name (path/to/its-todo.md)'],
    ['a repository named twice', '**Repositories**: backend (this todo), backend (minor)', 'backend is named twice'],
    ['two that claim this todo', '**Repositories**: backend (this todo), frontend (this todo)', 'Only one repository can be (this todo)'],
  ])('reports %s as a problem and guesses nothing', (_name, line, problem) => {
    expect(parseTodoRepositories(todo(line))).toEqual({ found: true, problem: expect.stringContaining(problem), entries: [] });
  });

  it('accepts as many repositories as a project can have, and one more is a problem', () => {
    const names = count => Array.from({ length: count }, (_unused, index) => `repo-${index} (minor)`).join(', ');
    expect(parseTodoRepositories(todo(`**Repositories**: ${names(TODO_REPOSITORIES_MAX)}`)).entries).toHaveLength(TODO_REPOSITORIES_MAX);
    expect(parseTodoRepositories(todo(`**Repositories**: ${names(TODO_REPOSITORIES_MAX + 1)}`))).toMatchObject({ found: true, problem: `Name at most ${TODO_REPOSITORIES_MAX} repositories`, entries: [] });
    expect(TODO_REPOSITORIES_MAX).toBe(9);
  });

  it('uses the first such line and reads only the top of the file', () => {
    expect(parseTodoRepositories(todo('**Repositories**: backend (minor)\n**Repositories**: frontend (minor)')).entries).toEqual([{ repository: 'backend', role: 'minor', todo: null }]);
    expect(parseTodoRepositories(`${'filler\n'.repeat(80)}**Repositories**: backend (minor)\n`).found).toBe(false);
  });

  it('refuses anything that is not text', () => {
    for (const value of [null, undefined, 7, {}]) expect(() => parseTodoRepositories(value)).toThrow('todo must be text');
  });
});
