import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerUpgradeCommand,
  upgradeInternals,
} from '../../src/commands/upgrade.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function command() {
  const program = new Command();
  program.exitOverride();
  return program;
}

describe('upgrade command', () => {
  it('registers check, dry-run, force, and exact target options', () => {
    const program = command();
    registerUpgradeCommand(program);
    const upgrade = program.commands.find(
      (candidate) => candidate.name() === 'upgrade',
    );
    expect(upgrade?.description()).toBe(
      'Check for and install librarium updates',
    );
    expect(upgrade?.options.map((option) => option.long)).toEqual([
      '--check',
      '--dry-run',
      '--force',
      '--target',
    ]);
  });

  it('uses an explicit validated older-version fixture target without fetching latest', async () => {
    const program = command();
    const fetchLatest = vi.fn(() => '9.9.9');
    const runCommand = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerUpgradeCommand(program, {
      current_version: '1.9.9',
      detect_install_method: () => 'npm',
      fetch_latest_version: fetchLatest,
      run_command: runCommand,
    });
    await program.parseAsync([
      'node',
      'test',
      'upgrade',
      '--dry-run',
      '--target',
      '2.0.0-rc.1',
    ]);
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'Would upgrade librarium: 1.9.9 → 2.0.0-rc.1 via npm',
    );
    expect(log).toHaveBeenCalledWith(
      'Would run: npm install -g librarium@2.0.0-rc.1',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects target interpolation and never fetches or executes it', async () => {
    const program = command();
    const fetchLatest = vi.fn(() => '9.9.9');
    const runCommand = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerUpgradeCommand(program, {
      current_version: '1.9.9',
      detect_install_method: () => 'yarn',
      fetch_latest_version: fetchLatest,
      run_command: runCommand,
    });
    await program.parseAsync([
      'node',
      'test',
      'upgrade',
      '--dry-run',
      '--target',
      '2.0.0;touch-injected',
    ]);
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Target version must use X.Y.Z or X.Y.Z-rc.N syntax.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('permits an explicit target only for dry runs', async () => {
    const program = command();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runCommand = vi.fn();
    registerUpgradeCommand(program, {
      current_version: '1.9.9',
      detect_install_method: () => 'npm',
      fetch_latest_version: () => '9.9.9',
      run_command: runCommand,
    });
    await program.parseAsync([
      'node',
      'test',
      'upgrade',
      '--target',
      '2.0.0-rc.1',
    ]);
    expect(error).toHaveBeenCalledWith(
      '--target is allowed only with --dry-run.',
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('executes package-manager upgrades with argument arrays', () => {
    expect(upgradeInternals.upgradeInvocation('npm', '2.0.0-rc.1')).toEqual({
      executable: 'npm',
      arguments_: ['install', '-g', 'librarium@2.0.0-rc.1'],
    });
    expect(upgradeInternals.upgradeInvocation('pnpm', '2.0.0-rc.1')).toEqual({
      executable: 'pnpm',
      arguments_: ['update', '-g', 'librarium@2.0.0-rc.1'],
    });
    expect(upgradeInternals.upgradeInvocation('yarn', '2.0.0-rc.1')).toEqual({
      executable: 'yarn',
      arguments_: ['global', 'upgrade', 'librarium@2.0.0-rc.1'],
    });
    expect(
      upgradeInternals.upgradeInvocation('homebrew', '2.0.0-rc.1'),
    ).toEqual({
      executable: 'brew',
      arguments_: ['upgrade', 'librarium'],
    });
    expect(
      upgradeInternals.upgradeInvocation('sea-standalone', '2.0.0-rc.1'),
    ).toBeNull();
  });
});
