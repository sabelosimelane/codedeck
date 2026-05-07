import { describe, expect, it } from 'vitest';
import {
  TERMINAL_EXECUTION_DEAD,
  TERMINAL_EXECUTION_IDLE,
  TERMINAL_EXECUTION_RUNNING,
  TERMINAL_EXECUTION_UNKNOWN,
  classifyTerminalExecution,
} from '../terminal-execution-classifier.js';

describe('terminal execution classifier', () => {
  it('reports dead panes before inspecting snapshot content', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'node',
      paneDead: '1',
      snapshotText: '• Working (34s • esc to interrupt)',
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_DEAD,
      foregroundCommand: null,
      executionReason: 'pane_dead',
      executionConfidence: 'high',
    });
  });

  it('reports unknown when tmux does not expose a foreground command', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '',
      paneDead: '0',
      snapshotText: 'some terminal text',
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_UNKNOWN,
      foregroundCommand: null,
      executionReason: 'missing_foreground_command',
      executionConfidence: 'low',
    });
  });

  it('treats a visible shell prompt as idle', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'zsh',
      paneDead: '0',
      snapshotText: [
        'Deployment to production completed successfully',
        '',
        'Completed at: 2026-04-25 15:17:38',
        'Total duration: 0m 59s',
        'dev@host frontend.v3 %',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: 'zsh',
      executionReason: 'shell_prompt',
      executionConfidence: 'high',
    });
  });

  it('keeps an interactive shell pane running when deployment output has not returned to a prompt', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'bash',
      paneDead: '0',
      snapshotText: [
        'Starting deployment process...',
        'Deploying to production...',
        'Waiting for rollout to complete...',
        'Waiting for deployment "backend-deploy" rollout to finish: 1 old replicas are pending termination...',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: 'bash',
      executionReason: 'shell_without_prompt',
      executionConfidence: 'medium',
    });
  });

  it('does not treat an old shell prompt above fresh deployment output as idle', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'zsh',
      paneDead: '0',
      snapshotText: [
        'dev@host frontend.v3 %',
        'Starting deployment process...',
        'Deploying to production...',
        'Building and pushing Docker image registry.example.com/alpha/frontend.v3:25.apr.15.33...',
        '=> exporting layers 1.2s',
        '=> exporting manifest sha256:2650ee 0.0s',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: 'zsh',
      executionReason: 'shell_without_prompt',
      executionConfidence: 'medium',
    });
  });

  it('keeps ordinary silent foreground commands running', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'npm',
      paneDead: '0',
      snapshotText: 'running tests without output',
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: 'npm',
      executionReason: 'foreground_command',
      executionConfidence: 'medium',
    });
  });

  it('keeps active Codex turns running when a Working marker is visible', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'node',
      paneDead: '0',
      snapshotText: [
        '• Working (34s • esc to interrupt)',
        '',
        '› Summarize recent commits',
        '',
        '  gpt-5.5 medium · ~/git/mace/backend',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: 'node',
      executionReason: 'agent_working',
      executionConfidence: 'high',
    });
  });

  it('keeps Codex running while it waits on a background terminal despite an input prompt', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'node',
      paneDead: '0',
      snapshotText: [
        '• Full verification is still running. The earlier targeted suites passed.',
        '',
        '• Waiting for background terminal (15m 02s • esc to interrupt) · 1 background terminal running',
        '  └ ./mvnw verify',
        '',
        '› Summarize recent commits',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: 'node',
      executionReason: 'agent_background_terminal',
      executionConfidence: 'high',
    });
  });

  it('treats an idle Codex input prompt as idle', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'node',
      paneDead: '0',
      snapshotText: [
        'Remaining risk: I did not run a live browser/API smoke',
        '',
        '› Summarize recent commits',
        '',
        '  gpt-5.5 medium · ~/git/alpha/backend',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: 'node',
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    });
  });

  it('treats a completed Claude-style prompt as idle', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '2.1.114',
      paneDead: '0',
      snapshotText: [
        'Want me to also verify there are not other blocks?',
        '',
        '───────────────────────────────────────────────────────────',
        '❯',
        '───────────────────────────────────────────────────────────',
        '  dev ~/git/alpha/backend Opus 4.7',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: '2.1.114',
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    });
  });

  it('keeps a streaming Claude Code pane running even when the input chevron is visible', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '2.1.114',
      paneDead: '0',
      snapshotText: [
        '✢ Smooshing…',
        '',
        '──────────────────────────────────────────────────────────',
        '❯',
        '──────────────────────────────────────────────────────────',
        '  dev ~/git/alpha/frontend.v3 Sonnet 4.6 | ctx: 100% used',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: '2.1.114',
      executionReason: 'agent_streaming',
      executionConfidence: 'high',
    });
  });

  it('keeps a long-running Claude Code turn running when the spinner reports tokens without esc-to-interrupt', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '2.1.114',
      paneDead: '0',
      snapshotText: [
        '⏺ Calling bash-server, kube-mcp 11 times… (ctrl+o to expand)',
        '',
        '· Orchestrating… (3m 30s · ↑ 1.5k tokens)',
        '',
        '──────────────────────────────────────────────────────────',
        '❯',
        '──────────────────────────────────────────────────────────',
        '  dev ~/git/alpha/frontend.v3 Opus 4.7 (1M context) | ctx: 8% used',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: '2.1.114',
      executionReason: 'agent_streaming',
      executionConfidence: 'high',
    });
  });

  it('still classifies a completed Claude turn as idle when only past-tense markers are visible', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '2.1.114',
      paneDead: '0',
      snapshotText: [
        '⏺ Done — backend now distinguishes 404 from 500.',
        '',
        '✻ Crunched for 37s',
        '',
        '──────────────────────────────────────────────────────────',
        '❯',
        '──────────────────────────────────────────────────────────',
        '  dev ~/git/alpha/backend Opus 4.7',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: '2.1.114',
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    });
  });

  it('does not let stale tool-call summary lines with mid-line ellipsis stick a finished pane in running', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '2.1.114',
      paneDead: '0',
      snapshotText: [
        '⏺ Calling bash-server, kube-mcp 11 times… (ctrl+o to expand)',
        '⏺ Read 3 files (ctrl+o to expand)',
        '',
        '✻ Worked for 7m 21s',
        '',
        '──────────────────────────────────────────────────────────',
        '❯',
        '──────────────────────────────────────────────────────────',
        '  dev ~/git/alpha/frontend.v3 Opus 4.7 (1M context) | ctx: 9% used',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: '2.1.114',
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    });
  });

  it('matches Claude Code spinners that put multi-token text between the verb and the ellipsis', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '2.1.114',
      paneDead: '0',
      snapshotText: [
        '⏺ Write(server/tests/services/devPromptService.test.js)',
        '  ⎿  Wrote 117 lines to server/tests/services/devPromptService.test.js',
        '',
        '✽ Phase 3.10: Tests… (7m 54s · ↓ 17.3k tokens · thought for 3s)',
        '  ⎿  ✔ Phase 3.1: Add executionMode + pendingStepReview persistence',
        '     ◼ Phase 3.10: Tests',
        '',
        '──────────────────────────────────────────────────────────',
        '❯',
        '──────────────────────────────────────────────────────────',
        '  dev ~/git/tool-runner Opus 4.7 (1M context) | ctx: 15% used',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand: '2.1.114',
      executionReason: 'agent_streaming',
      executionConfidence: 'high',
    });
  });

  it('treats a chevron line carrying typed-in ellipsis as idle, not streaming', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: '2.1.114',
      paneDead: '0',
      snapshotText: [
        '✻ Worked for 1m 12s',
        '',
        '──────────────────────────────────────────────────────────',
        '❯ Tell me more about that…',
        '──────────────────────────────────────────────────────────',
        '  dev ~/git/foo Opus 4.7',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: '2.1.114',
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    });
  });

  it('does not let Codex transcript-truncation markers like "… +48 lines (ctrl + t to view transcript)" pin an idle pane to running', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'node',
      paneDead: '0',
      snapshotText: [
        '• Ran git diff --stat && git diff --name-only --diff-filter=U',
        '  └  .workflow/integration-parity-alignment.md         |   7 +',
        '     CLAUDE.md                                          |   2 +',
        '    … +48 lines (ctrl + t to view transcript)',
        '     src/manifest.webmanifest                           |   6 +-',
        '',
        '• Done. The frontend working tree is now committed on local main.',
        '',
        '› Explain this codebase',
        '',
        '  gpt-5.5 medium · ~/git/alpha/backend',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: 'node',
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    });
  });

  it('does not let Codex pipe-continuation truncation markers like "│ … +16 lines" pin an idle pane to running', () => {
    expect(classifyTerminalExecution({
      paneCurrentCommand: 'node',
      paneDead: '0',
      snapshotText: [
        '• Ran git commit -m "Refactor module exports across packages" -m "This consolidates the',
        '  │ public exports of the affected packages and updates the entry point so downstream',
        '  │ consumers import from a single re-export rather than reaching into internals',
        '  │ … +16 lines',
        '  └ [main 6101665] Refactor module exports across packages',
        '',
        '› Explain this codebase',
        '',
        '  gpt-5.5 medium · ~/git/alpha/backend',
      ].join('\n'),
    })).toMatchObject({
      executionStatus: TERMINAL_EXECUTION_IDLE,
      foregroundCommand: 'node',
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    });
  });
});
