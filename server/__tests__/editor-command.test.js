import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITOR_COMMAND, resolveEditorCommand } from '../editor-command.js';

describe('resolveEditorCommand', () => {
  it('defaults to VS Code when no custom command is stored', () => {
    expect(resolveEditorCommand()).toEqual(DEFAULT_EDITOR_COMMAND.split(' '));
  });

  it('preserves quoted arguments in custom editor commands', () => {
    expect(resolveEditorCommand('open -a "Visual Studio Code"')).toEqual([
      'open',
      '-a',
      'Visual Studio Code',
    ]);
  });

  it('falls back to the default command when the stored value is blank', () => {
    expect(resolveEditorCommand('   ')).toEqual(DEFAULT_EDITOR_COMMAND.split(' '));
  });
});
