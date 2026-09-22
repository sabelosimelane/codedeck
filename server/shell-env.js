import path from 'path';
import { fileURLToPath } from 'url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const zshWrapperDir = path.join(serverDir, 'shell', 'zsh');
const NODE_WATCH_INTERNAL_ENV_KEYS = ['WATCH_REPORT_DEPENDENCIES'];

export function stripNodeWatchEnvironment(env) {
  for (const key of NODE_WATCH_INTERNAL_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export function buildShellEnv(shellPath, baseEnv = process.env) {
  const env = stripNodeWatchEnvironment({ ...baseEnv, TERM: 'xterm-256color' });
  const shellName = path.basename(shellPath || '');

  if (shellName !== 'zsh') return env;

  const userZdotdir = baseEnv.USER_ZDOTDIR || baseEnv.ZDOTDIR || baseEnv.HOME;
  return {
    ...env,
    USER_ZDOTDIR: userZdotdir,
    ZDOTDIR: zshWrapperDir,
  };
}
