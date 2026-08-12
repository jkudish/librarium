import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/types.js';

const state = vi.hoisted(() => ({
  consentReached: false,
  createCredentials: vi.fn(),
  executeRun: vi.fn(),
  onboarding: vi.fn(),
  confirm: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const config: Config = {
  version: 1,
  defaults: {
    outputDir: './agents/librarium',
    maxParallel: 1,
    timeout: 30,
    asyncTimeout: 300,
    asyncPollInterval: 5,
    mode: 'sync',
    llmWebSearch: true,
  },
  providers: { exa: { enabled: true } },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  text: vi.fn(async () => 'credential-less query'),
  select: vi
    .fn()
    .mockResolvedValueOnce('enabled')
    .mockResolvedValueOnce('sync'),
  multiselect: vi.fn(),
  confirm: (...args: unknown[]) => state.confirm(...args),
  isCancel: () => false,
  log: {
    error: (...args: unknown[]) => state.logError(...args),
    message: vi.fn(),
    warn: (...args: unknown[]) => state.logWarn(...args),
  },
}));

vi.mock('../src/core/config.js', () => ({
  configGroupProvenance: () => ({ global: config.groups, project: {} }),
  loadConfig: () => config,
  loadProjectConfig: () => null,
  mergeConfigs: () => config,
}));

vi.mock('../src/node-credentials.js', () => ({
  createNodeCredentialContext: (...args: unknown[]) =>
    state.createCredentials(...args),
}));

vi.mock('../src/commands/run.js', () => ({
  executeRun: (...args: unknown[]) => state.executeRun(...args),
}));

vi.mock('../src/commands/onboarding.js', () => ({
  runOnboardingWizard: (...args: unknown[]) => state.onboarding(...args),
}));

vi.mock('../src/commands/browse.js', () => ({
  browseRunDir: vi.fn(),
}));

import { runWizard } from '../src/commands/wizard.js';

describe('wizard missing-credential onboarding', () => {
  beforeEach(() => {
    state.consentReached = false;
    state.createCredentials.mockReset().mockImplementation(() => {
      expect(state.consentReached).toBe(true);
      return { env: {} };
    });
    state.confirm.mockReset().mockImplementation(async () => {
      state.consentReached = true;
      return true;
    });
    state.executeRun.mockReset().mockResolvedValue({
      exitCode: 0,
    });
    state.onboarding.mockReset().mockResolvedValue(undefined);
    state.logError.mockReset();
    state.logWarn.mockReset();
    process.exitCode = undefined;
  });

  it('does structural admission before consent and opens onboarding for missing credentials', async () => {
    await runWizard();

    expect(state.createCredentials).toHaveBeenCalledOnce();
    expect(state.executeRun).not.toHaveBeenCalled();
    expect(state.onboarding).toHaveBeenCalledOnce();
    expect(state.logError).not.toHaveBeenCalled();
  });
});
