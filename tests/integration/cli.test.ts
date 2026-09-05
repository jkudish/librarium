import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Integration tests run against the built CLI.
// Run `npm run build` before executing these tests.
const CLI = resolve(import.meta.dirname, '../../dist/cli.js');
const TEST_HOME = mkdtempSync(resolve(tmpdir(), 'librarium-integration-'));

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function run(args: string, home = TEST_HOME): string {
  try {
    return execSync(`node ${CLI} ${args}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
      },
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('CLI integration', () => {
  it('--help shows all command names', () => {
    const output = run('--help');
    for (const cmd of [
      'run',
      'status',
      'ls',
      'groups',
      'init',
      'doctor',
      'config',
      'cleanup',
      'upgrade',
      'install-skill',
    ]) {
      expect(output).toContain(cmd);
    }
  });

  it('--version matches semver pattern', () => {
    const output = run('--version');
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('ls shows provider table', () => {
    const output = run('ls');
    expect(output).toContain('Name');
  });

  it('ls --json returns valid JSON array', () => {
    const output = run('ls --json');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it('config --json returns valid JSON', () => {
    const output = run('config --json');
    const parsed = JSON.parse(output);
    expect(typeof parsed).toBe('object');
  });

  it('loads a CLI-migrated v2 config through config, doctor, and run preflight', () => {
    if (process.platform === 'win32') return;
    const source = resolve(TEST_HOME, 'migration-source-v1.json');
    const destination = resolve(TEST_HOME, '.config/librarium/config.json');
    writeFileSync(
      source,
      JSON.stringify({
        version: 1,
        defaults: {
          outputDir: './agents/librarium',
          maxParallel: 2,
          timeout: 30,
          asyncTimeout: 1800,
          asyncPollInterval: 10,
          mode: 'sync',
          llmWebSearch: true,
        },
        providers: { exa: { enabled: false } },
        customProviders: {},
        trustedProviderIds: [],
        groups: {},
      }),
    );

    const migrated = JSON.parse(
      run(`config migrate --from ${source} --output ${destination}`),
    );
    expect(migrated.version).toBe(2);
    expect(JSON.parse(readFileSync(destination, 'utf8')).version).toBe(2);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    writeFileSync(
      destination,
      JSON.stringify({
        ...migrated,
        execution_defaults: {
          ...migrated.execution_defaults,
          request_deadline_ms: 1_900_000,
        },
      }),
    );

    const configured = JSON.parse(run('config --json'));
    expect(configured.providers.exa.enabled).toBe(false);
    expect(configured.defaults.requestDeadlineMs).toBe(1_900_000);
    expect(Array.isArray(JSON.parse(run('doctor --json')))).toBe(true);

    const preflight = run(
      'run "offline preflight" --providers exa --json --yes',
    );
    expect(preflight).not.toContain('Invalid Librarium v2 config');
    expect(preflight).toContain('profile_disabled');
  });

  it('groups shows default group names', () => {
    const output = run('groups');
    for (const group of [
      'deep',
      'quick',
      'raw',
      'visibility',
      'comprehensive',
      'all',
    ]) {
      expect(output).toContain(group);
    }
  });

  it('groups --json returns valid JSON', () => {
    const output = run('groups --json');
    const parsed = JSON.parse(output);
    expect(typeof parsed).toBe('object');
  });

  it('cleanup --dry-run runs without error', () => {
    // Should exit 0 even with no output dirs
    const output = run('cleanup --dry-run');
    expect(output).toBeDefined();
  });

  it('doctor --json returns valid JSON', () => {
    const output = run('doctor --json');
    const parsed = JSON.parse(output);
    expect(typeof parsed).toBe('object');
  });

  it('doctor text and JSON do not execute trusted custom provider code', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'librarium-doctor-offline-'));
    const marker = resolve(home, 'custom-provider-executed');
    const npmProvider = resolve(home, 'side-effect-provider.mjs');
    const scriptProvider = resolve(home, 'side-effect-provider-script.mjs');
    const configDir = resolve(home, '.config/librarium');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      npmProvider,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, 'npm imported');`,
        'export default {',
        "  id: 'side-effect-npm',",
        "  displayName: 'Side Effect NPM',",
        "  tier: 'raw-search',",
        "  execution: 'inline',",
        "  envVar: '',",
        '  requiresApiKey: false,',
        '  async execute() { throw new Error("unused"); },',
        '};',
      ].join('\n'),
    );
    writeFileSync(
      scriptProvider,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, 'script spawned');`,
      ].join('\n'),
    );
    writeFileSync(
      resolve(configDir, 'config.json'),
      JSON.stringify({
        version: 1,
        defaults: {
          outputDir: './agents/librarium',
          maxParallel: 2,
          timeout: 30,
          asyncTimeout: 1800,
          asyncPollInterval: 10,
          mode: 'sync',
          llmWebSearch: true,
        },
        providers: {
          'side-effect-npm': { enabled: true },
          'side-effect-script': { enabled: true },
        },
        customProviders: {
          'side-effect-npm': { type: 'npm', module: npmProvider },
          'side-effect-script': {
            type: 'script',
            command: process.execPath,
            args: [scriptProvider],
          },
        },
        trustedProviderIds: ['side-effect-npm', 'side-effect-script'],
        groups: {},
      }),
    );

    try {
      const text = run('doctor', home);
      expect(text).toContain('side-effect-npm');
      expect(text).toContain('side-effect-script');
      expect(text).toContain(
        'Credential requirements unknown; connectivity not tested',
      );
      expect(existsSync(marker)).toBe(false);

      const results = JSON.parse(run('doctor --json', home));
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'side-effect-npm',
            credentialStatus: 'unknown',
            connectivity: 'unchecked',
          }),
          expect.objectContaining({
            id: 'side-effect-script',
            credentialStatus: 'unknown',
            connectivity: 'unchecked',
          }),
        ]),
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
