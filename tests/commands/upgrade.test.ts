import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerUpgradeCommand } from '../../src/commands/upgrade.js';

describe('upgrade command', () => {
  it('registers the upgrade command', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'upgrade');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe('Check for and install librarium updates');
  });

  it('has --check option', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'upgrade');
    const checkOption = cmd?.options.find((o) => o.long === '--check');
    expect(checkOption).toBeDefined();
  });

  it('has --dry-run option', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'upgrade');
    const dryRunOption = cmd?.options.find((o) => o.long === '--dry-run');
    expect(dryRunOption).toBeDefined();
  });

  it('has --force option', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'upgrade');
    const forceOption = cmd?.options.find((o) => o.long === '--force');
    expect(forceOption).toBeDefined();
  });

  it('description mentions updates', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'upgrade');
    expect(cmd?.description()).toContain('updates');
  });
});
