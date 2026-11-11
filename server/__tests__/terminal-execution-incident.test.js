import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TERMINAL_EXECUTION_IDLE,
  classifyTerminalExecution,
} from '../terminal-execution-classifier.js';

const screen = name => readFileSync(
  new URL(`./fixtures/agent-screens/${name}`, import.meta.url),
  'utf8'
);

describe('terminal execution classifier — stale transcript markers', () => {
  it('reports running for a finished Codex turn whose answer contains a "Working tree clean" bullet', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'codex',
      paneDead: '0',
      subagentPanes: [], quietSeconds: 0,
      snapshotText: screen('codex/turn-complete-working-tree-bullet.txt'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: 'codex',
      executionReason: 'agent_prompt_idle',
    });
  });
});
