// The "Now" screen: what is running, what needs you, and what you touched
// recently — everything else stays out of the way. The rules mirror the
// desktop's: amber for finished / needs input, green for running, nothing for
// idle; muted sessions lose their colour, parked ones leave the active list.
import { getTerminalPaneLabel } from '../utils/terminalActivity';
import { describeRunStatus, describeStepProgress } from '../utils/pipelineRunStatus';

/** How long after its last meaningful activity a session still counts as active. */
export const ACTIVE_WINDOW_MS = 8 * 60 * 60 * 1000;
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const MOST_RECENT = 3;

export function ago(time, now) {
  if (time === null) return '';
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 2 * DAY) return 'Yesterday';
  return `${Math.floor(elapsed / DAY)}d`;
}
const agoPhrase = (time, now) => { const label = ago(time, now); return label === 'now' ? 'just now' : label === 'Yesterday' ? 'yesterday' : `${label} ago`; };
const needs = count => (count === 1 ? '1 needs you' : `${count} need you`);

const RUN_TONE = { active: 'running', waiting: 'needs', danger: 'needs', done: 'idle', neutral: 'idle' };
const folderName = path => path.split('/').filter(Boolean).at(-1);

/**
 * A workflow run as one row, named after its task. Its terminals are listed on the row, not
 * in the session list. A run of a project that is not among the projects is not shown, as on
 * the desktop, which lists runs under their project.
 */
function taskRows({ runs, tasks, projects, sessions, now }) {
  const projectByName = new Map(projects.map(project => [project.name, project]));
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  return runs.filter(run => projectByName.has(run.project)).map(run => {
    const project = projectByName.get(run.project);
    const status = describeRunStatus(run);
    const current = run.steps[run.currentStepIndex];
    const progress = describeStepProgress(current);
    const activity = Date.parse(run.updatedAt);
    if (!Number.isFinite(activity)) throw new Error(`Now view: run ${run.id} has no valid time of change`);
    const parked = project.state !== 'active';
    const running = status.tone === 'active';
    const ids = [...new Set(run.steps.map(step => step.sessionId).filter(id => id !== null))];
    // A task in several repositories lists them, when the instance says which they are.
    const worktrees = taskById.get(run.taskId)?.worktrees ?? null;
    const repositories = worktrees !== null && worktrees.length > 1
      ? worktrees.map(worktree => ({ name: worktree.repository, state: worktree.state, current: worktree.worktreePath === run.worktree.path })) : null;
    return {
      repositories,
      key: run.id, run, title: taskById.get(run.taskId)?.title ?? folderName(run.worktree.path),
      workflowName: run.workflowName, projectName: project.name, label: status.label,
      tone: parked ? 'idle' : RUN_TONE[status.tone], parked,
      step: run.status === 'complete' ? null : [`Step ${run.currentStepIndex + 1} of ${run.steps.length}`, current.name, progress.detail].filter(Boolean).join(' · '),
      when: running ? 'now' : ago(activity, now), activity, sessionIds: ids,
      sessions: ids.map(id => sessionById.get(id)).filter(Boolean),
      counts: { running: running && !parked, needs: status.needsOwner && !parked },
      active: !parked && (running || status.needsOwner || run.status === 'pending' || Math.max(0, now - activity) <= ACTIVE_WINDOW_MS),
    };
  }).sort((a, b) => b.activity - a.activity || a.title.localeCompare(b.title));
}

export function buildNowView({ sessions, projects, now, scope, query, runs, tasks }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Now view: now must be a nonnegative integer time');
  if (scope !== 'active' && scope !== 'all') throw new Error('Now view: scope must be active or all');
  if (typeof query !== 'string') throw new Error('Now view: query must be text');
  if (!Array.isArray(runs)) throw new Error('Now view: runs must be a list');
  if (!Array.isArray(tasks)) throw new Error('Now view: tasks must be a list');
  const allTasks = taskRows({ runs, tasks, projects, sessions, now });
  // A run stands for its terminals: they are reached from its task and counted once, as the run.
  const inRun = new Set(allTasks.flatMap(row => row.sessionIds));
  const projectById = new Map(projects.map(project => [project.id, project]));

  const rows = sessions.filter(session => !inRun.has(session.id)).map(session => {
    const project = projectById.get(session.projectId);
    if (!project) throw new Error(`Now view: session ${session.id} belongs to an unknown project`);
    const running = session.live && session.status === 'running';
    const ended = session.live && session.status === 'dead';
    const attention = !session.live || ended ? null : session.needsInput ? 'Needs input' : session.finished ? 'Finished' : null;
    const parked = session.waiting || project.state === 'waiting';
    const quiet = session.muted || parked;
    const tone = ended ? 'ended' : quiet ? 'idle' : attention ? 'needs' : running ? 'running' : 'idle';
    const note = !session.live ? `Last known: ${session.status === 'dead' ? 'ended' : session.status}`
      : ended ? 'Ended' : attention ?? (running ? getTerminalPaneLabel(session, 'Running') : '');
    const elapsed = session.lastActivityAt === null ? Infinity : Math.max(0, now - session.lastActivityAt);
    return {
      id: session.id, key: session.incarnationId, session, title: session.title, projectName: project.name,
      tone, note, parked, muted: session.muted,
      when: running ? 'now' : ago(session.lastActivityAt, now),
      age: running || elapsed < HOUR ? 0 : elapsed < DAY ? 1 : 2,
      activity: session.lastActivityAt,
      counts: { running: running && !quiet, needs: attention !== null && !quiet },
      active: session.live && !ended && !parked && project.state === 'active'
        && (running || attention !== null || elapsed <= ACTIVE_WINDOW_MS),
    };
  }).sort((a, b) => (b.activity ?? -1) - (a.activity ?? -1) || a.title.localeCompare(b.title));

  const running = [...rows, ...allTasks].filter(row => row.counts.running).length;
  const needing = [...rows, ...allTasks].filter(row => row.counts.needs).length;
  const latest = rows.find(row => row.activity !== null);
  const headline = running ? `${running} running` : needing ? needs(needing) : 'All quiet';
  const summary = running
    ? { headlineTone: 'plain', subline: needing ? needs(needing) : 'Nothing needs you', sublineTone: needing ? 'needs' : 'quiet' }
    : needing ? { headlineTone: 'needs', subline: 'Nothing running', sublineTone: 'quiet' }
      : { headlineTone: 'plain', subline: !rows.length && !allTasks.length ? 'No open sessions' : latest ? `Last activity ${agoPhrase(latest.activity, now)}` : 'Last activity unknown', sublineTone: 'quiet' };

  const needle = query.trim().toLocaleLowerCase();
  const active = rows.filter(row => row.active);
  const rest = rows.filter(row => !row.active);
  let groups;
  if (needle) {
    const found = rows.filter(row => `${row.title} ${row.projectName}`.toLocaleLowerCase().includes(needle));
    groups = found.length ? [{ label: 'Results', showLabel: false, rows: found }] : [];
  } else if (scope === 'all') {
    groups = [{ label: 'Active', showLabel: false, rows: active }, { label: 'Earlier', showLabel: true, rows: rest }].filter(group => group.rows.length);
  } else if (active.length) {
    groups = [{ label: 'Active', showLabel: false, rows: active }];
  } else {
    // Nothing in flight: show where you left off instead of an empty screen.
    groups = rows.length ? [{ label: 'Most recent', showLabel: true, rows: rows.slice(0, MOST_RECENT) }] : [];
  }
  const shown = groups.reduce((count, group) => count + group.rows.length, 0);
  const listed = needle ? allTasks.filter(row => `${row.title} ${row.workflowName} ${row.projectName}`.toLocaleLowerCase().includes(needle))
    : scope === 'all' ? allTasks : allTasks.filter(row => row.active);
  return {
    headline, ...summary, groups, tasks: listed, searching: needle !== '',
    quietCount: needle ? 0 : rows.length - shown, quietTaskCount: needle ? 0 : allTasks.length - listed.length,
  };
}
