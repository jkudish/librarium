import { describe, expect, it } from 'vitest';
import {
  bashCompletions,
  fishCompletions,
  zshCompletions,
} from '../src/commands/completions.js';

const GROUPS = ['deep', 'quick', 'raw', 'fast', 'comprehensive', 'all'];
const COMMANDS = ['run', 'status', 'browse', 'html', 'refine', 'completions'];

describe('shell completions', () => {
  it('zsh script covers commands, flags, and group names', () => {
    const script = zshCompletions();
    expect(script).toContain('#compdef librarium');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain('--providers');
    expect(script).toContain('--refine');
    for (const group of GROUPS) expect(script).toContain(group);
  });

  it('bash script covers commands, flags, and group names', () => {
    const script = bashCompletions();
    expect(script).toContain('complete -F _librarium_completions librarium');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain('--html');
    expect(script).toContain(GROUPS.join(' '));
  });

  it('fish script covers commands, flags, and group names', () => {
    const script = fishCompletions();
    expect(script).toContain('__fish_use_subcommand');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain(
      "-s g -l group -a 'deep quick raw fast comprehensive all'",
    );
  });

  it('contains no em-dashes', () => {
    for (const script of [
      zshCompletions(),
      bashCompletions(),
      fishCompletions(),
    ]) {
      expect(script).not.toContain('—');
    }
  });
});
