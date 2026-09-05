import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CLI = resolve(import.meta.dirname, '../../dist/cli.js');
const HOME = mkdtempSync(resolve(tmpdir(), 'librarium-plan-integration-'));
const RUNS = resolve(HOME, 'runs');

mkdirSync(resolve(HOME, '.config/librarium'), { recursive: true });
writeFileSync(
  resolve(HOME, '.config/librarium/config.json'),
  JSON.stringify({
    version: 1,
    defaults: {
      outputDir: RUNS,
      maxParallel: 2,
      timeout: 30,
      asyncTimeout: 300,
      asyncPollInterval: 5,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: { 'brave-search': { enabled: true } },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  }),
);

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function plan(...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'plan', ...args], {
    cwd: HOME,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      HOME,
      PATH: process.env.PATH,
      BRAVE_API_KEY: 'locally-present-only',
    },
  });
}

describe('built plan CLI', () => {
  it('documents the approved interface', () => {
    const result = plan('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: librarium plan [options] <query>');
    expect(result.stdout).toContain('--answer');
    expect(result.stdout).toContain('--verify');
    expect(result.stdout).not.toContain('--for');
  });

  it('renders text and sanitized JSON without run artifacts', () => {
    const human = plan('human output', '--providers', 'brave-search');
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('Research plan');
    expect(human.stdout).toContain('brave-search/search');
    expect(human.stdout).toContain('credentials untested');
    expect(human.stdout).not.toMatch(/[{}]|microusd|Diagnostics:/);

    const json = plan(
      'private json query',
      '--providers',
      'brave-search',
      '--json',
    );
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schema_version: 1,
      artifact: 'librarium.plan',
      status: 'ready',
    });
    expect(json.stdout).not.toContain('private json query');
    expect(json.stdout).not.toContain('locally-present-only');
    expect(existsSync(RUNS)).toBe(false);
  });

  it('returns exit 2 and JSON diagnostics for invalid and blocked admission', () => {
    const invalid = plan('invalid', '--verify', '--json');
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      status: 'blocked',
      ready: false,
      issues: [{ code: 'verification_requires_answer' }],
    });
    expect(invalid.stderr).toBe('');

    const blocked = plan(
      'over budget',
      '--providers',
      'brave-search',
      '--max-estimated-cost',
      '0.001',
      '--json',
    );
    expect(blocked.status).toBe(2);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      status: 'blocked',
      ready: false,
      issues: [{ code: 'primary_plan_budget_exceeded' }],
    });
    expect(blocked.stderr).toBe('');
    expect(existsSync(RUNS)).toBe(false);
  });

  it.each([
    [
      ['parser value', '--parallel', 'not-a-number', '--json'],
      'plan_cli_invalid_argument',
    ],
    [
      ['parser value', '--json', '--mode', 'not-a-mode'],
      'plan_cli_invalid_argument',
    ],
    [
      ['parser value', '--providers', ',secret-provider-value', '--json'],
      'plan_cli_invalid_argument',
    ],
    [['--json'], 'plan_cli_missing_query'],
    [['parser value', '--json', '--timeout'], 'plan_cli_missing_option_value'],
    [['parser value', '--max-cost', '--json'], 'plan_cli_missing_option_value'],
    [
      ['parser value', '--json', '--secret-option-value'],
      'plan_cli_unknown_option',
    ],
    [
      ['parser value', '--secret-option-value', '--json'],
      'plan_cli_unknown_option',
    ],
  ])('sanitizes parser failure %# as a blocked JSON receipt', (args, code) => {
    const result = plan(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema_version: 1,
      artifact: 'librarium.plan',
      status: 'blocked',
      ready: false,
      issues: [{ code }],
      credential_check: {
        semantics: 'not_checked',
        structural_validation_ran_first: false,
        keychain_lookup_allowed: false,
      },
    });
    expect(result.stdout).not.toContain('not-a-number');
    expect(result.stdout).not.toContain('not-a-mode');
    expect(result.stdout).not.toContain('secret-provider-value');
    expect(result.stdout).not.toContain('secret-option-value');
  });

  it('preserves human parser failures as exit 2 without changing other commands', () => {
    const invalidPlan = plan('parser value', '--parallel', 'not-a-number');
    expect(invalidPlan.status).toBe(2);
    expect(invalidPlan.stdout).toBe('');
    expect(invalidPlan.stderr).toContain('Cannot plan:');
    expect(invalidPlan.stderr).not.toContain('not-a-number');

    const invalidOtherCommand = spawnSync(
      process.execPath,
      [CLI, 'run', 'query', '--parallel', 'not-a-number'],
      { cwd: HOME, encoding: 'utf8', env: { HOME, PATH: process.env.PATH } },
    );
    expect(invalidOtherCommand.status).toBe(1);
  });
});
