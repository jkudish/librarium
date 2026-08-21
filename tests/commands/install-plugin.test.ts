import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerInstallPluginCommand } from '../../src/commands/install-plugin.js';

describe('install-plugin command', () => {
  it('registers the install-plugin command', () => {
    const program = new Command();
    registerInstallPluginCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-plugin');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe(
      'Install the Amp plugin for AI-assisted research',
    );
  });

  it('has --force option', () => {
    const program = new Command();
    registerInstallPluginCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-plugin');
    const forceOption = cmd?.options.find((o) => o.long === '--force');
    expect(forceOption).toBeDefined();
  });

  it('has --dry-run option', () => {
    const program = new Command();
    registerInstallPluginCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-plugin');
    const dryRunOption = cmd?.options.find((o) => o.long === '--dry-run');
    expect(dryRunOption).toBeDefined();
  });
});
