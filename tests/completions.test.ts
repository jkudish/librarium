import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  bashCompletions,
  fishCompletions,
  zshCompletions,
} from '../src/commands/completions.js';
import { createRunCliProgram } from '../src/run-cli-program.js';

const GROUPS = ['exa', 'kagi', 'openai', 'chatgpt', 'copilot'];
const COMMANDS = [
  'research',
  'show',
  'browse',
  'html',
  'summarize',
  'completions',
];
const program = createRunCliProgram();
const bashAvailable = spawnSync('bash', ['--version']).status === 0;
const zshAvailable = spawnSync('zsh', ['--version']).status === 0;

describe('shell completions', () => {
  it('zsh script covers commands, flags, and group names', () => {
    const script = zshCompletions(program);
    expect(script).toContain('#compdef librarium');
    for (const command of COMMANDS) expect(script).toContain(command);
    expect(script).toContain('--only');
    expect(script).toContain('--deep');
    expect(script).toContain("'research:Research a question'");
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
    expect(script).toContain('--only');
    for (const name of GROUPS) expect(script).toContain(name);
    expect(script).toContain(
      'if [[ " research " == *" ${cmd} "* && ( "${prev}" == "--only" || "${prev}" == "--skip" ) ]]; then',
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
    expect(script).toContain('-l only -a');
    for (const name of GROUPS) expect(script).toContain(name);
    expect(script).not.toContain('-l group');
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
