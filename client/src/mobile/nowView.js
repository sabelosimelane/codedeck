// The "Now" screen: what is running, what needs you, and what you touched
// recently — everything else stays out of the way. The rules mirror the
// desktop's: amber for finished / needs input, green for running, nothing for
// idle; muted sessions lose their colour, parked ones leave the active list.
import { getTerminalPaneLabel } from '../utils/terminalActivity';

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

export function buildNowView({ sessions, projects, now, scope, query }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Now view: now must be a nonnegative integer time');
  if (scope !== 'active' && scope !== 'all') throw new Error('Now view: scope must be active or all');
  if (typeof query !== 'string') throw new Error('Now view: query must be text');
  const projectById = new Map(projects.map(project => [project.id, project]));

  const rows = sessions.map(session => {
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

  const running = rows.filter(row => row.counts.running).length;
  const needing = rows.filter(row => row.counts.needs).length;
  const latest = rows.find(row => row.activity !== null);
  const headline = running ? `${running} running` : needing ? needs(needing) : 'All quiet';
  const summary = running
    ? { headlineTone: 'plain', subline: needing ? needs(needing) : 'Nothing needs you', sublineTone: needing ? 'needs' : 'quiet' }
    : needing ? { headlineTone: 'needs', subline: 'Nothing running', sublineTone: 'quiet' }
      : { headlineTone: 'plain', subline: !rows.length ? 'No open sessions' : latest ? `Last activity ${agoPhrase(latest.activity, now)}` : 'Last activity unknown', sublineTone: 'quiet' };

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
  return { headline, ...summary, groups, searching: needle !== '', quietCount: needle ? 0 : rows.length - shown };
}
