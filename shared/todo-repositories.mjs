/**
 * A todo can say which repositories its work touches, on one line among its header lines:
 *
 *   **Repositories**: backend (this todo), mobile-app (docs/todos/x-phone.md), frontend (minor)
 *
 * `this todo` is the repository the todo lives in, a path is another repository's own todo, and
 * `minor` is a repository the same run may change without a todo of its own. Whoever writes the
 * todo decides; CodeDeck only reads the line, and reports a line it cannot read instead of guessing.
 */

import { isProgressFilePath, isRepositoryName } from './pipeline-definitions.mjs';

// A project has its own repository and at most eight others.
export const TODO_REPOSITORIES_MAX = 9;
// The line belongs to the todo's header: before its first section and near the top.
const HEADER_LINES = 60;
const LINE = /^\*\*Repositories\*\*:(.*)$/;
const ENTRY = /^([^\s(),·]+)\s*\(([^()]*)\)\s*/;
const FORMAT = 'Write each repository as name (this todo), name (minor) or name (path/to/its-todo.md), with commas between them';

const none = { found: false, problem: null, entries: [] };
const problem = message => ({ found: true, problem: message, entries: [] });

function readRole(raw) {
  const text = raw.trim().replace(/^`(.*)`$/, '$1').trim();
  if (text === 'this todo') return { role: 'this', todo: null };
  if (text === 'minor') return { role: 'minor', todo: null };
  return isProgressFilePath(text) ? { role: 'todo', todo: text } : null;
}

export function parseTodoRepositories(todo) {
  if (typeof todo !== 'string') throw new TypeError('todo must be text');
  let rest = null;
  for (const line of todo.split('\n').slice(0, HEADER_LINES)) {
    if (line.startsWith('## ')) break;
    const match = LINE.exec(line.trim());
    if (match) { rest = match[1].trim(); break; }
  }
  if (rest === null) return none;
  if (rest === '') return problem('The Repositories line names no repository');

  const entries = [];
  while (rest !== '') {
    const match = ENTRY.exec(rest);
    if (!match || !isRepositoryName(match[1])) return problem(FORMAT);
    const read = readRole(match[2]);
    if (read === null) return problem(`${match[1]} (${match[2].trim()}): use this todo, minor, or the path of a .md file inside that repository`);
    if (entries.some(entry => entry.repository === match[1])) return problem(`${match[1]} is named twice`);
    entries.push({ repository: match[1], ...read });
    rest = rest.slice(match[0].length);
    if (rest === '') break;
    // Entries are separated by a comma or a middle dot; anything else is not this format.
    if (rest[0] !== ',' && rest[0] !== '·') return problem(FORMAT);
    rest = rest.slice(1).trim();
    if (rest === '') return problem(FORMAT);
  }
  if (entries.length > TODO_REPOSITORIES_MAX) return problem(`Name at most ${TODO_REPOSITORIES_MAX} repositories`);
  if (entries.filter(entry => entry.role === 'this').length > 1) return problem('Only one repository can be (this todo)');
  return { found: true, problem: null, entries };
}
