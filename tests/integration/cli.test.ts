import { execSync } from 'node:child_process';
import {
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

function run(args: string): string {
  try {
    return execSync(`node ${CLI} ${args}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: TEST_HOME,
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
});
