import { useEffect, useMemo, useRef, useState } from 'react';
import { parseTask } from '../utils/tasksApi';

const STORAGE_KEY = 'codedeck-dismissed-task-tabs';
const taskKey = task => JSON.stringify([task.project, task.id]);

// Dismissal is a per-browser view preference, not task state: an unreadable stored list is
// reported and discarded, so the tabs reappear instead of the whole app failing to render.
function readDismissed() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return { tasks: [], error: null };
    const tasks = JSON.parse(stored);
    if (!Array.isArray(tasks)) throw new Error('Dismissed task tabs must be a list');
    return { tasks: tasks.map(parseTask), error: null };
  } catch (error) {
    console.error(`Discarding stored ${STORAGE_KEY}: ${error.message}`);
    return { tasks: [], error };
  }
}

function writeDismissed(serialized) {
  try {
    if (serialized !== localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    console.warn(`Could not save dismissed task tabs: ${error.message}`);
  }
}

/** Tab visibility is local. Known tasks always remain in the routing data. */
export function useTaskTabs(authoritativeTasks, showToast) {
  const initial = useRef(null);
  if (initial.current === null) initial.current = readDismissed();
  const [dismissed, setDismissed] = useState(initial.current.tasks);
  useEffect(() => {
    const { error } = initial.current;
    if (error) showToast({ type: 'error', message: `Saved dismissed task tabs could not be read and were reset: ${error.message}` });
  }, [showToast]);
  const [created, setCreated] = useState([]);
  const [reopenedBeforeRead, setReopenedBeforeRead] = useState([]);
  const confirmed = useMemo(() => new Map(authoritativeTasks?.map(task => [taskKey(task), task])), [authoritativeTasks]);

  useEffect(() => {
    if (authoritativeTasks === null) return;
    setCreated(current => {
      const unconfirmed = current.filter(task => !confirmed.has(taskKey(task)));
      return unconfirmed.length === current.length ? current : unconfirmed;
    });
    setReopenedBeforeRead(current => current.length === 0 ? current : []);
  }, [authoritativeTasks, confirmed]);

  const tasks = useMemo(() => {
    const known = new Map();
    if (authoritativeTasks === null) {
      for (const task of [...dismissed, ...reopenedBeforeRead]) known.set(taskKey(task), task);
    }
    for (const task of created) known.set(taskKey(task), task);
    for (const [key, task] of confirmed) known.set(key, task);
    return [...known.values()];
  }, [authoritativeTasks, confirmed, created, dismissed, reopenedBeforeRead]);

  useEffect(() => {
    const known = new Map(tasks.map(task => [taskKey(task), task]));
    const current = dismissed.map(task => known.get(taskKey(task))).filter(Boolean);
    const serialized = JSON.stringify(current);
    if (serialized !== JSON.stringify(dismissed)) setDismissed(current);
    writeDismissed(serialized);
  }, [dismissed, tasks]);

  const isTaskDismissed = task => dismissed.some(entry => taskKey(entry) === taskKey(task));
  const dismiss = task => setDismissed(current => current.some(entry => taskKey(entry) === taskKey(task)) ? current : [...current, task]);
  const reopen = task => {
    if (authoritativeTasks === null) setReopenedBeforeRead(current => [...current, task]);
    setDismissed(current => current.filter(entry => taskKey(entry) !== taskKey(task)));
  };
  const taskCreated = task => setCreated(current => [...current.filter(entry => taskKey(entry) !== taskKey(task)), task]);
  const taskFinished = task => setCreated(current => current.filter(entry => taskKey(entry) !== taskKey(task)));
  return { tasks, isTaskDismissed, dismiss, reopen, taskCreated, taskFinished };
}
