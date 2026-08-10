import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createCliProgram } from '../src/cli-program.js';
import {
  bashCompletions,
  fishCompletions,
  zshCompletions,
} from '../src/commands/completions.js';

const GROUPS = [
  'deep',
  'quick',
  'raw',
  'fast',
  'visibility',
  'comprehensive',
  'llm',
  'all',
];
const COMMANDS = ['run', 'status', 'browse', 'html', 'refine', 'completions'];
const program = createCliProgram();
const bashAvailable = spawnSync('bash', ['--version']).status === 0;

describe('shell completions', () => {
  it('zsh script covers commands, flags, and group names', () => {
    const script = zshCompletions(program);
    expect(script).toContain('#compdef librarium');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain('--providers');
    expect(script).toContain('--refine');
    for (const group of GROUPS) expect(script).toContain(group);
    for (const command of program.commands) {
      for (const option of command.options) {
        if (option.short) expect(script).toContain(option.short);
        if (option.long) expect(script).toContain(option.long);
      }
    }
  });

  it('bash script covers commands, flags, and group names', () => {
    const script = bashCompletions(program);
    expect(script).toContain('complete -F _librarium_completions librarium');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain('--html');
    expect(script).toContain(GROUPS.join(' '));
  });

  it.skipIf(!bashAvailable)('emits Bash with valid syntax', () => {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-n'], {
      input: bashCompletions(program),
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fish script covers commands, flags, and group names', () => {
    const script = fishCompletions(program);
    expect(script).toContain('__fish_use_subcommand');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain(
      "-s g -l group -a 'deep quick raw fast visibility comprehensive llm all'",
    );
  });

  it('contains no em-dashes', () => {
    for (const script of [
      zshCompletions(program),
      bashCompletions(program),
      fishCompletions(program),
    ]) {
      expect(script).not.toContain('—');
    }
  });
});
