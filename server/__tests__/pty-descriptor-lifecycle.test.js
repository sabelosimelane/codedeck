import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { spawn } from 'node-pty';

const describeOnMacOS = process.platform === 'darwin' ? describe : describe.skip;

function countOpenPtyMasters() {
  const output = execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' });
  return output.split('\n').filter(line => line.endsWith(' /dev/ptmx')).length;
}

function spawnAndStopProbe() {
  return new Promise((resolve, reject) => {
    let ptyProcess;
    try {
      ptyProcess = spawn(process.execPath, ['-e', ''], {
        name: 'xterm-256color',
        cols: 1,
        rows: 1,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (err) {
      reject(err);
      return;
    }

    ptyProcess.onExit(resolve);
    ptyProcess.kill();
  });
}

describeOnMacOS('node-pty descriptor lifecycle', () => {
  it('releases every PTY master after repeated terminal shutdowns', async () => {
    const baseline = countOpenPtyMasters();

    for (let index = 0; index < 20; index += 1) {
      await spawnAndStopProbe();
    }

    expect(countOpenPtyMasters()).toBe(baseline);
  });
});
