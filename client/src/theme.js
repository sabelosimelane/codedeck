// Theme management — dark, light "paper terminal", and system (follows OS).
// The *resolved* theme lives on <html data-theme="dark|light"> so global.css
// variable overrides apply everywhere; the user's *mode* (dark|light|system)
// is what gets persisted. Components that need JS values (xterm) listen for
// the THEME_CHANGE_EVENT broadcast, whose detail is the resolved theme.

const STORAGE_KEY = 'codedeck-theme';
export const THEME_CHANGE_EVENT = 'codedeck-theme-change';
export const THEME_MODES = ['dark', 'light', 'system'];

const systemQuery = window.matchMedia('(prefers-color-scheme: light)');
let currentMode = 'system';

export const XTERM_THEMES = {
  dark: {
    background: '#0e0e10',
    foreground: '#e4e4e8',
    cursor: '#6ee7b7',
    selectionBackground: '#6ee7b740',
    black: '#0e0e10',
    red: '#f87171',
    green: '#6ee7b7',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e4e4e8',
    brightBlack: '#5a5a66',
    brightRed: '#fca5a5',
    brightGreen: '#a7f3d0',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#faf8f2',
    foreground: '#2b3138',
    cursor: '#0e9b74',
    selectionBackground: '#0e9b7433',
    black: '#3d434b',
    red: '#c73e3e',
    green: '#0e8a63',
    yellow: '#9a6b00',
    blue: '#1f6fc5',
    magenta: '#8f4bbf',
    cyan: '#0e7fa8',
    white: '#faf8f2',
    brightBlack: '#6b727c',
    brightRed: '#e05252',
    brightGreen: '#0e9b74',
    brightYellow: '#b97e0f',
    brightBlue: '#3b82d6',
    brightMagenta: '#a565d6',
    brightCyan: '#1494c2',
    brightWhite: '#ffffff',
  },
};

function systemTheme() {
  return systemQuery.matches ? 'light' : 'dark';
}

function resolveTheme(mode) {
  return mode === 'system' ? systemTheme() : mode;
}

function applyResolvedTheme() {
  const resolved = resolveTheme(currentMode);
  if (document.documentElement.dataset.theme !== resolved) {
    document.documentElement.dataset.theme = resolved;
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: resolved }));
  }
}

/** The user-selected mode: 'dark' | 'light' | 'system'. */
export function getThemeMode() {
  return currentMode;
}

/** The theme actually in effect right now: 'dark' | 'light'. */
export function getResolvedTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setThemeMode(mode) {
  currentMode = THEME_MODES.includes(mode) ? mode : 'system';
  try {
    localStorage.setItem(STORAGE_KEY, currentMode);
  } catch {
    // Non-critical preference persistence.
  }
  applyResolvedTheme();
}

/** Cycle dark → light → system → dark. Returns the new mode. */
export function cycleThemeMode() {
  const next = THEME_MODES[(THEME_MODES.indexOf(currentMode) + 1) % THEME_MODES.length];
  setThemeMode(next);
  return next;
}

export function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Non-critical preference persistence.
  }
  currentMode = THEME_MODES.includes(stored) ? stored : 'system';
  document.documentElement.dataset.theme = resolveTheme(currentMode);
  systemQuery.addEventListener('change', () => {
    if (currentMode === 'system') applyResolvedTheme();
  });
}
