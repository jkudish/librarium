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
const zshAvailable = spawnSync('zsh', ['--version']).status === 0;

describe('shell completions', () => {
  it('zsh script covers commands, flags, and group names', () => {
    const script = zshCompletions(program);
    expect(script).toContain('#compdef librarium');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain('--providers');
    expect(script).toContain('--refine');
    expect(script).toContain(
      "'run:Run a research query across multiple providers'",
    );
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
    expect(script).toContain(
      'if [[ " run plan answer " == *" ${cmd} "* && ( "${prev}" == "-g" || "${prev}" == "--group" ) ]]; then',
    );
  });

  it.skipIf(!bashAvailable)('emits Bash with valid syntax', () => {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-n'], {
      input: bashCompletions(program),
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('emits valid zsh syntax when zsh is available', () => {
    const script = zshCompletions(program);
    if (!zshAvailable) {
      // Windows runners may not provide zsh; pin its complete function shape
      // there instead of silently skipping every assertion.
      expect(script).toContain('_librarium() {');
      expect(script).toContain('case $words[2] in');
      expect(script).toContain('compdef _librarium librarium');
      return;
    }

    const result = spawnSync('zsh', ['-n'], {
      input: script,
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
