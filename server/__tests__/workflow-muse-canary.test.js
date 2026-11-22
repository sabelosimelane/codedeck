import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalWorkflow, findPassSignal } from '../terminal-workflow.js';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';
import { findAgentProfile } from '../agent-profiles/index.js';

// Opt-in: each case consumes a real model turn on the named development host.
// A private tmux server isolates both the paste buffer and the terminal.
const host = process.env.CODEDECK_MUSE_CANARY_HOST;
it.skipIf(!host).each(['clean', 'damaged'])('remote Muse disposition (%s)', async mode => {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host)) throw new Error('Invalid SSH host');
  const ssh = (command, input) => execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=5',host,command], {input,encoding:'utf8',timeout:8000}).trimEnd();
  const id = randomUUID();
  const dir = ssh('mktemp -d /tmp/codedeck-canary.XXXXXXXX');
  expect(dir).toMatch(/^\/tmp\/codedeck-canary\.[a-zA-Z0-9]+$/);
  const tmux = 'tmux -L cd-' + id;
  const events = [];
  const record = (kind, detail) => events.push({time:new Date().toISOString(),kind,detail});
  const workflow = createTerminalWorkflow({
    write(data) {
      if (data === '\r') ssh(tmux + ' send-keys -t sample Enter');
      else {
        ssh(tmux + ' load-buffer -', data.replace(/^\x1b\[200~|\x1b\[201~$/g,''));
        ssh(tmux + ' paste-buffer -dp -t sample');
      }
    },
    notify() {},
  });
  workflow.setAudit(record);
  try {
    ssh('cd ' + dir + ' && git init -q && ' + tmux + ' new-session -d -s sample -x 160 -y 50 -c ' + dir + ' "$HOME/.local/bin/muse --model muse-spark-1.3-contributor --effort high --yolo"');
    const start = Date.now();
    let sent = false;
    let idle = 0;
    let firstIdle = null;
    let reason;
    while (Date.now() - start < 90000) {
      const command = ssh(tmux + " display -p -t sample '#{pane_current_command}'");
      const screen = ssh(tmux + ' capture-pane -p -J -t sample');
      const lines = screen.split('\n');
      const state = classifyTerminalExecution({paneCurrentCommand:command,paneDead:0,snapshotText:screen,subagentPanes:[],quietSeconds:0});
      reason = state.executionReason;
      const ready = reason === 'agent_prompt_idle' && findAgentProfile({foregroundCommand:command,lines})?.promptVisible(lines);
      if (!sent && ready) {
        record('ready', command);
        const commandText = mode === 'damaged'
          ? 'Handoff transport test. No tools. On this first response deliberately substitute a semicolon for the FIRST colon of the COMPLETE signal. When CodeDeck asks you to correct it, emit the correct COMPLETE signal immediately.'
          : 'Handoff transport test. No tools. Finish immediately with the COMPLETE signal.';
        workflow.start({requestId:id,command:commandText,resetCommand:'/clear',maxIterations:1});
        sent = true;
      } else if (sent) {
        const current = workflow.exportState();
        const signal = current && findPassSignal(screen,current);
        if (signal) workflow.output(`[[CDW:${signal.id}:${signal.signal}]]`);
        if (ready && /\[\[CDW;[\w-]+:COMPLETE\]\]/.test(screen)) firstIdle ??= Date.now();
        idle = ready ? idle + 1 : 0;
        if (reason === 'agent_working') workflow.observeTurn('working',screen);
        if (idle >= 2) workflow.observeTurn('idle',screen);
        if (!workflow.snapshot().active) break;
      }
      await delay(500);
    }
    record('outcome', workflow.snapshot().status);
    console.log(JSON.stringify({id,mode,host,cwd:dir,reason,events,firstDamagedIdle:firstIdle && new Date(firstIdle).toISOString()}));
    expect(workflow.snapshot().status).toBe('complete');
    expect(events.filter(e=>e.kind === 'prompt_submitted')).toHaveLength(1);
    expect(events.filter(e=>e.kind === 'disposition_requested')).toHaveLength(mode === 'clean' ? 0 : 1);
    if (mode === 'damaged') {
      expect(firstIdle).toBeTypeOf('number');
      expect(Date.now() - firstIdle).toBeLessThan(30000);
    }
  } finally {
    workflow.stop();
    ssh(tmux + ' kill-server 2>/dev/null || true');
    // Retain the isolated checkout for inspection.
  }
},120000);
