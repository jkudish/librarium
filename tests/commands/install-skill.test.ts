import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerInstallSkillCommand } from '../../src/commands/install-skill.js';

describe('install-skill command', () => {
  it('registers the install-skill command', () => {
    const program = new Command();
    registerInstallSkillCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-skill');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe(
      'Install the Claude Code skill for AI-assisted research',
    );
  });

  it('has --force option', () => {
    const program = new Command();
    registerInstallSkillCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-skill');
    const forceOption = cmd?.options.find((o) => o.long === '--force');
    expect(forceOption).toBeDefined();
  });

  it('has --dry-run option', () => {
    const program = new Command();
    registerInstallSkillCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-skill');
    const dryRunOption = cmd?.options.find((o) => o.long === '--dry-run');
    expect(dryRunOption).toBeDefined();
  });
});
