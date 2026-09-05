import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Provider } from '../src/types.js';

const state = vi.hoisted(() => ({
  hasMissingCredential: false,
  passTest: vi.fn(async () => ({ ok: true })),
  failTest: vi.fn(async () => ({ ok: false, error: 'mock outage' })),
  disabledTest: vi.fn(async () => ({ ok: true })),
  missingCredentialTest: vi.fn(async () => ({ ok: true })),
}));

function provider(
  id: string,
  test?: () => Promise<{ ok: boolean; error?: string }>,
): Provider {
  return {
    id,
    displayName: id,
    tier: 'raw-search',
    execution: 'inline',
    envVar: `${id.toUpperCase()}_API_KEY`,
    execute: vi.fn(),
    test,
  };
}

vi.mock('../src/adapters/node-registry.js', () => ({
  initializeProviders: vi.fn(async () => ({
    warnings: [],
    loadedCustomProviders: [],
    skippedCustomProviders: [],
  })),
  getAllProviders: vi.fn(() => [
    provider('passing', state.passTest),
    provider('failing', state.failTest),
    provider('disabled', state.disabledTest),
    provider('missing', state.missingCredentialTest),
    provider('unavailable'),
  ]),
}));

const config: Config = {
  version: 1,
  defaults: {
    outputDir: './agents/librarium',
    maxParallel: 1,
    timeout: 30,
    asyncTimeout: 1800,
    asyncPollInterval: 10,
    mode: 'sync',
    llmWebSearch: true,
  },
  providers: {
    passing: { enabled: true },
    failing: { enabled: true },
    disabled: { enabled: false },
    missing: { enabled: true },
    unavailable: { enabled: true },
  },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

vi.mock('../src/core/config.js', () => ({
  loadConfig: vi.fn(() => config),
  loadProjectConfig: vi.fn(() => null),
  mergeConfigs: vi.fn(() => config),
}));

vi.mock('../src/core/provider-selection.js', () => ({
  providerHasCredential: vi.fn(
    (candidate: Provider) =>
      candidate.id !== 'missing' || state.hasMissingCredential,
  ),
}));

vi.mock('../src/node-credentials.js', () => ({
  createNodeCredentialContext: vi.fn(() => ({ env: {} })),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    text: '',
    start() {
      return this;
    },
    stop: vi.fn(),
    fail: vi.fn(),
  })),
}));

import { registerDoctorCommand } from '../src/commands/doctor.js';

function program(): Command {
  const command = new Command();
  command.name('librarium');
  registerDoctorCommand(command);
  return command;
}

function calls(): string[] {
  return vi.mocked(console.log).mock.calls.map(([message]) => String(message));
}

describe('doctor command', () => {
  beforeEach(() => {
    state.hasMissingCredential = false;
    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each([[[]], [['--json']]])(
    'does not run provider tests by default with arguments %j',
    async (args) => {
      await program().parseAsync(['node', 'librarium', 'doctor', ...args]);

      expect(state.passTest).not.toHaveBeenCalled();
      expect(state.failTest).not.toHaveBeenCalled();
      expect(state.disabledTest).not.toHaveBeenCalled();
      expect(state.missingCredentialTest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);

      if (args.includes('--json')) {
        const results = JSON.parse(calls().at(-1) ?? '[]');
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'passing',
              connectivity: 'unchecked',
            }),
            expect.objectContaining({ id: 'disabled', connectivity: 'skip' }),
            expect.objectContaining({ id: 'missing', connectivity: 'fail' }),
            expect.objectContaining({
              id: 'unavailable',
              connectivity: 'no-test',
            }),
          ]),
        );
      } else {
        expect(calls().join('\n')).toContain(
          'Credential present; connectivity not tested',
        );
        expect(calls().join('\n')).not.toContain('Connected');
      }
    },
  );

  it.each([[['--live']], [['--live', '--json']]])(
    'runs eligible provider tests only with --live and fails in format %j',
    async (args) => {
      state.hasMissingCredential = true;
      await program().parseAsync(['node', 'librarium', 'doctor', ...args]);

      expect(state.passTest).toHaveBeenCalledTimes(1);
      expect(state.failTest).toHaveBeenCalledTimes(1);
      expect(state.disabledTest).not.toHaveBeenCalled();
      expect(state.missingCredentialTest).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);

      if (args.includes('--json')) {
        const results = JSON.parse(calls().at(-1) ?? '[]');
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'passing', connectivity: 'pass' }),
            expect.objectContaining({ id: 'failing', connectivity: 'fail' }),
            expect.objectContaining({
              id: 'unavailable',
              connectivity: 'no-test',
            }),
          ]),
        );
      } else {
        expect(calls().join('\n')).toContain('mock outage');
      }
    },
  );

  it('discloses live request and charge behavior in help', () => {
    const doctor = program().commands.find(
      (command) => command.name() === 'doctor',
    );
    const live = doctor?.options.find((option) => option.long === '--live');

    expect(live?.description).toContain('network requests');
    expect(live?.description).toContain('provider charges');
  });
});
