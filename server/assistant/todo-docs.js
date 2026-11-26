import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listDirtyPaths } from '../pipelines/run-worktree.js';
import { parsePhaseBreakdown } from '../pipelines/run-progress.js';
import { parseTodoRepositories } from '../../shared/todo-repositories.mjs';

const defaultExecFile = callbackExecFile;
const MAX_DOCS = 50;
const MAX_BYTES = 512 * 1024;
const requireText = (value, field, identity) => {
  if (typeof value !== 'string' || !value) throw new Error(`${identity}: ${field} must be a non-empty string`);
  return value;
};

const count = (value, field, identity) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${identity}: ${field} must be a non-negative integer`); return value; };
function checkedRepositories(value, identity) {
  if (!value || typeof value !== 'object' || typeof value.found !== 'boolean' || !Array.isArray(value.entries) || (value.problem !== null && typeof value.problem !== 'string')) throw new Error(`${identity}: repositories must be parsed`);
  value.entries.forEach((entry, index) => {
    requireText(entry?.repository, `repositories.entries[${index}].repository`, identity);
    requireText(entry?.role, `repositories.entries[${index}].role`, identity);
    if (entry.todo !== null) requireText(entry.todo, `repositories.entries[${index}].todo`, identity);
  });
  return value;
}

function headerLine(markdown, field) {
  const line = markdown.split(/\r?\n/).find(item => item.startsWith(`**${field}**:`));
  return line ? line.slice(field.length + 5).trim().replace(/^`(.*)`$/, '$1') : null;
}

export async function readTodoDocs({ root, location, dirtyPaths, execFile = defaultExecFile } = {}) {
  requireText(root, 'root', String(root));
  requireText(location, 'location', root);
  if (!path.isAbsolute(root)) throw new Error(`${root}: root must be absolute`);
  if (typeof execFile !== 'function') throw new Error(`${root}: execFile must be a function`);
  let rootStat;
  try { rootStat = await fs.stat(root); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { missing: true };
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error(`${root}: location must be a folder`);
  if (dirtyPaths !== undefined && !Array.isArray(dirtyPaths)) throw new Error(`${root}: dirtyPaths must be an array`);
  const dirty = new Set(dirtyPaths ?? await listDirtyPaths({ worktreePath: root, execFile, detailed: true }).then(result => result.paths));
  for (const file of dirty) requireText(file, 'dirty path', root);
  const skipped = [];
  const truncated = { todos: false, specifications: false };

  async function readGroup(folder, kind) {
    let names;
    try { names = await fs.readdir(path.join(root, 'docs', folder)); }
    catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error(`${root}: ${folder} names must be text`);
    const matches = names.filter(name => name.endsWith('.md')).sort().reverse();
    truncated[kind] = matches.length > MAX_DOCS;
    const docs = [];
    for (const name of matches.slice(0, MAX_DOCS)) {
      const rel = `docs/${folder}/${name}`;
      const absolute = path.join(root, rel);
      // A file the reader cannot use is named in `skipped` with why, so one odd file never hides the rest.
      let stat;
      try { stat = await fs.stat(absolute); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        skipped.push({ path: rel, size: null, reason: 'missing' }); continue;
      }
      if (!stat.isFile()) { skipped.push({ path: rel, size: null, reason: 'not_a_file' }); continue; }
      count(stat.size, 'size', rel);
      if (stat.size > MAX_BYTES) { skipped.push({ path: rel, size: stat.size, reason: 'too_large' }); continue; }
      const committed = !dirty.has(rel);
      if (kind === 'specifications') { docs.push({ path: rel, location, committed }); continue; }
      const markdown = await fs.readFile(absolute, 'utf8');
      if (typeof markdown !== 'string') throw new Error(`${rel}: contents must be text`);
      const title = markdown.split(/\r?\n/).find(line => line.startsWith('# '))?.slice(2).trim();
      if (!title) { skipped.push({ path: rel, size: stat.size, reason: 'no_title' }); continue; }
      const beforeSection = markdown.split(/^##[ \t]/m)[0];
      const dependsOn = [...new Set(beforeSection.split(/\r?\n/).filter(line => line.startsWith('>')).flatMap(line => line.match(/docs\/todos\/[\w./-]+\.md/g) ?? []))];
      const spec = headerLine(markdown, 'Spec');
      const status = headerLine(markdown, 'Status');
      if (spec !== null) requireText(spec, 'spec', rel);
      if (status !== null) requireText(status, 'status', rel);
      dependsOn.forEach((entry, index) => requireText(entry, `dependsOn[${index}]`, rel));
      const phases = parsePhaseBreakdown(markdown);
      if (!Array.isArray(phases)) throw new Error(`${rel}: phases must be an array`);
      phases.forEach((phase, index) => { count(phase?.number, `phases[${index}].number`, rel); if (typeof phase.title !== 'string') throw new Error(`${rel}: phases[${index}].title must be text`); count(phase.done, `phases[${index}].done`, rel); count(phase.total, `phases[${index}].total`, rel); });
      docs.push({ path: rel, location, title, spec, status, repositories: checkedRepositories(parseTodoRepositories(markdown), rel), dependsOn, phases, committed, contentHash: createHash('sha256').update(markdown).digest('hex') });
    }
    return docs;
  }

  const todos = await readGroup('todos', 'todos');
  const specifications = await readGroup('specifications', 'specifications');
  for (const [kind, value] of Object.entries(truncated)) if (typeof value !== 'boolean') throw new Error(`${root}: truncated.${kind} must be boolean`);
  return { todos, specifications, skipped, truncated };
}
