import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Provider } from '../src/types.js';

const state = vi.hoisted(() => ({
  hasMissingCredential: false,
  initializeProviders: vi.fn(async () => ({
    warnings: [],
    loadedCustomProviders: [],
    skippedCustomProviders: [],
  })),
  passTest: vi.fn(async () => ({ ok: true })),
  failTest: vi.fn(async () => ({ ok: false, error: 'mock outage' })),
  disabledTest: vi.fn(async () => ({ ok: true })),
  missingCredentialTest: vi.fn(async () => ({ ok: true })),
  returnedCustomTest: vi.fn(async () => ({
    ok: false,
    error: 'provider returned RETURNED_SECRET in its failure',
  })),
  throwingCustomTest: vi.fn(async () => {
    throw new Error('provider threw THROWN_SECRET in its exception');
  }),
}));

function provider(
  id: string,
  test?: () => Promise<{ ok: boolean; error?: string }>,
  source?: 'builtin' | 'npm' | 'script',
): Provider {
  return {
    id,
    displayName: id,
    tier: 'raw-search',
    execution: 'inline',
    envVar: `${id.toUpperCase()}_API_KEY`,
    execute: vi.fn(),
    test,
    source,
  };
}

vi.mock('../src/adapters/node-registry.js', () => ({
  initializeProviders: state.initializeProviders,
  getAllProviders: vi.fn(() => [
    provider('claude', state.passTest),
    provider('serpapi', state.failTest),
    provider('brave-search', state.disabledTest),
    provider('tavily', state.missingCredentialTest),
    provider('unavailable', undefined, 'npm'),
    provider('returned-custom', state.returnedCustomTest, 'npm'),
    provider('throwing-custom', state.throwingCustomTest, 'npm'),
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
    claude: { enabled: true },
    serpapi: { enabled: true },
    'brave-search': { enabled: false },
    tavily: { enabled: true },
    unavailable: { enabled: true },
    'returned-custom': { enabled: true, apiKey: 'RETURNED_SECRET' },
    'throwing-custom': { enabled: true, apiKey: 'THROWN_SECRET' },
  },
  customProviders: {
    unavailable: { type: 'npm', module: 'unavailable-provider' },
    'returned-custom': { type: 'npm', module: 'returned-provider' },
    'throwing-custom': { type: 'npm', module: 'throwing-provider' },
  },
  trustedProviderIds: ['unavailable', 'returned-custom', 'throwing-custom'],
  groups: {},
};

vi.mock('../src/core/config.js', () => ({
  loadConfig: vi.fn(() => config),
  loadProjectConfig: vi.fn(() => null),
  mergeConfigs: vi.fn(() => config),
}));

vi.mock('../src/core/provider-selection.js', () => ({
  providerCredentialRef: vi.fn(
    (
      candidate: Pick<Provider, 'envVar'>,
      providerConfig?: { apiKey?: string },
    ) => providerConfig?.apiKey ?? `$${candidate.envVar}`,
  ),
  providerHasCredential: vi.fn(
    (candidate: Pick<Provider, 'envVar'>) =>
      candidate.envVar !== 'TAVILY_API_KEY' || state.hasMissingCredential,
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
      expect(state.returnedCustomTest).not.toHaveBeenCalled();
      expect(state.throwingCustomTest).not.toHaveBeenCalled();
      expect(state.initializeProviders).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);

      if (args.includes('--json')) {
        const results = JSON.parse(calls().at(-1) ?? '[]');
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'claude',
              connectivity: 'unchecked',
            }),
            expect.objectContaining({
              id: 'brave-search',
              connectivity: 'skip',
            }),
            expect.objectContaining({ id: 'tavily', connectivity: 'fail' }),
            expect.objectContaining({
              id: 'unavailable',
              credentialStatus: 'unknown',
              connectivity: 'unchecked',
            }),
          ]),
        );
      } else {
        expect(calls().join('\n')).toContain(
          'Credential present; connectivity not tested',
        );
        expect(calls().join('\n')).toContain(
          'Credential requirements unknown; connectivity not tested',
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
      expect(state.returnedCustomTest).toHaveBeenCalledTimes(1);
      expect(state.throwingCustomTest).toHaveBeenCalledTimes(1);
      expect(state.initializeProviders).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);

      if (args.includes('--json')) {
        const results = JSON.parse(calls().at(-1) ?? '[]');
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'claude', connectivity: 'pass' }),
            expect.objectContaining({ id: 'serpapi', connectivity: 'fail' }),
            expect.objectContaining({
              id: 'unavailable',
              connectivity: 'no-test',
            }),
            expect.objectContaining({
              id: 'returned-custom',
              connectivity: 'fail',
              error: 'provider returned [REDACTED] in its failure',
            }),
            expect.objectContaining({
              id: 'throwing-custom',
              connectivity: 'fail',
              error: 'provider threw [REDACTED] in its exception',
            }),
          ]),
        );
      } else {
        expect(calls().join('\n')).toContain('mock outage');
      }
      expect(calls().join('\n')).toContain('[REDACTED]');
      expect(calls().join('\n')).not.toContain('RETURNED_SECRET');
      expect(calls().join('\n')).not.toContain('THROWN_SECRET');
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
