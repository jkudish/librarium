import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGroupsCommand } from '../../src/commands/groups.js';
import { loadConfig } from '../../src/core/config.js';
import type { Config } from '../../src/types.js';

function configFile(groups: Record<string, string[]>): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 30,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: { exa: { enabled: true } },
    customProviders: {},
    trustedProviderIds: [],
    groups,
  };
}

function program(
  config: Config,
  saveConfig: (next: Config) => void = () => {},
): Command {
  const command = new Command();
  command.exitOverride();
  registerGroupsCommand(command, {
    loadConfig: () => config,
    saveConfig,
  });
  return command;
}

describe('groups command', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'librarium-groups-command-'));
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function loadedConfig(groups: Record<string, string[]>): Config {
    const path = join(directory, 'config.json');
    writeFileSync(path, JSON.stringify(configFile(groups)));
    return loadConfig(path);
  }

  it('lists only four built-ins and canonical custom groups', async () => {
    const config = loadedConfig({ 'custom:team': ['exa/search'] });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program(config).parseAsync(['node', 'librarium', 'groups', '--json']);

    const groups = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(Object.keys(groups)).toEqual([
      'quick',
      'deep',
      'visibility',
      'all',
      'custom:team',
    ]);
    expect(groups['custom:team']).toEqual(['exa/search']);
    for (const removed of ['raw', 'fast', 'llm', 'comprehensive']) {
      expect(groups).not.toHaveProperty(removed);
    }
  });

  it('adds canonical groups without persisting injected legacy defaults', async () => {
    const config = loadedConfig({ 'custom:existing': ['exa/search'] });
    const save = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program(config, save).parseAsync([
      'node',
      'librarium',
      'groups',
      'add',
      'custom:team',
      'exa/search',
    ]);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: {
          'custom:existing': ['exa/search'],
          'custom:team': ['exa/search'],
        },
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('removes only an authored canonical custom group', async () => {
    const config = loadedConfig({
      'custom:existing': ['exa/search'],
      'custom:remove-me': ['exa/search'],
    });
    const save = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program(config, save).parseAsync([
      'node',
      'librarium',
      'groups',
      'remove',
      'custom:remove-me',
    ]);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: { 'custom:existing': ['exa/search'] },
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ['add', 'quick', 'exa/search'],
    ['add', 'team', 'exa/search'],
    ['add', 'custom:', 'exa/search'],
    ['remove', 'quick'],
    ['remove', 'team'],
  ])('rejects unusable or reserved group input: %s %s', async (...args) => {
    const load = vi.fn(() => configFile({}));
    const save = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const command = new Command();
    command.exitOverride();
    registerGroupsCommand(command, { loadConfig: load, saveConfig: save });

    await command.parseAsync(['node', 'librarium', 'groups', ...args]);

    expect(error).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
