import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configCommandInternals,
  registerConfigCommand,
} from '../src/commands/config.js';

function v1(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 4,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: {},
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...overrides,
  };
}

function program(): Command {
  const command = new Command();
  command
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerConfigCommand(command);
  return command;
}

describe('config migrate command', () => {
  let directory: string;
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'librarium-config-migrate-cli-'));
    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('registers the documented nested interface', () => {
    const config = program().commands.find(
      (candidate) => candidate.name() === 'config',
    );
    const migrate = config?.commands.find(
      (candidate) => candidate.name() === 'migrate',
    );

    expect(migrate).toBeDefined();
    expect(migrate?.options.map((option) => option.long)).toEqual([
      '--from',
      '--project',
      '--output',
      '--force',
    ]);
    expect(
      migrate?.options.find((option) => option.long === '--from')?.mandatory,
    ).toBe(true);
  });

  it('previews merged v2 JSON without mutating global or project sources', async () => {
    const globalPath = join(directory, 'global-v1.json');
    const projectPath = join(directory, 'project-v1.json');
    const global = `${JSON.stringify(v1(), null, 2)}\n`;
    const project = `${JSON.stringify(
      {
        version: 1,
        defaults: { maxParallel: 2 },
      },
      null,
      2,
    )}\n`;
    writeFileSync(globalPath, global);
    writeFileSync(projectPath, project);

    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
      '--project',
      projectPath,
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      version: 2,
      execution_defaults: { max_concurrency: 2 },
      trusted_provider_ids: [],
    });
    expect(readFileSync(globalPath, 'utf8')).toBe(global);
    expect(readFileSync(projectPath, 'utf8')).toBe(project);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints a sanitized receipt instead of secret-bearing config after writing', async () => {
    const secret = 'literal-secret-that-must-not-be-echoed';
    const globalPath = join(directory, 'secret-v1.json');
    const outputPath = join(directory, 'secret-v2.json');
    writeFileSync(
      globalPath,
      JSON.stringify(
        v1({
          providers: {
            exa: { enabled: true, apiKey: secret },
          },
        }),
      ),
    );

    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
      '--output',
      outputPath,
    ]);

    expect(JSON.parse(stdout)).toEqual({
      written: true,
      outputPath,
      version: 2,
    });
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('providers');
    expect(readFileSync(outputPath, 'utf8')).toContain(secret);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails when an explicitly requested project config is missing', async () => {
    const globalPath = join(directory, 'global-v1.json');
    writeFileSync(globalPath, JSON.stringify(v1()));

    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
      '--project',
      join(directory, 'missing-project.json'),
    ]);

    expect(stdout).toBe('');
    expect(stderr).toContain('"level":"issue"');
    expect(stderr).toContain('config_file_read_failed');
    expect(stderr).toContain('"path":"/project"');
    expect(process.exitCode).toBe(1);
  });

  it('emits structured notices and secret-safe issues on stderr', async () => {
    const globalPath = join(directory, 'global-v1.json');
    writeFileSync(
      globalPath,
      JSON.stringify(
        v1({
          providers: {
            'brave-answers': {
              enabled: true,
              apiKey: '$BRAVE_API_KEY',
            },
          },
        }),
      ),
    );

    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
    ]);

    expect(stderr).toContain('"level":"notice"');
    expect(stderr).toContain('config_credential_reference_migrated');

    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    const secret = 'supersecret-api-key';
    writeFileSync(globalPath, `{"apiKey":${secret}}`);
    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
    ]);

    expect(stdout).toBe('');
    expect(stderr).toContain('"level":"issue"');
    expect(stderr).toContain('config_json_invalid');
    expect(stderr).not.toContain(secret);
    expect(process.exitCode).toBe(1);
  });

  it('never auto-trusts a custom provider', async () => {
    const globalPath = join(directory, 'custom-v1.json');
    writeFileSync(
      globalPath,
      JSON.stringify(
        v1({
          providers: { acme: { enabled: true } },
          customProviders: {
            acme: { type: 'npm', module: '@acme/librarium-provider' },
          },
        }),
      ),
    );

    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
    ]);

    expect(stdout).toBe('');
    expect(stderr).toContain('config_custom_provider_untrusted');
    expect(stderr).not.toContain('"trusted_provider_ids":["acme"]');
    expect(process.exitCode).toBe(1);
  });

  it('writes owner-only only to an explicit non-source destination and requires force', async () => {
    if (process.platform === 'win32') return;
    const globalPath = join(directory, 'global-v1.json');
    const outputPath = join(directory, 'config-v2.json');
    const source = JSON.stringify(v1());
    writeFileSync(globalPath, source);

    const invoke = async (...extra: string[]) => {
      await program().parseAsync([
        'node',
        'librarium',
        'config',
        'migrate',
        '--from',
        globalPath,
        '--output',
        outputPath,
        ...extra,
      ]);
    };

    await invoke();
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
      version: 2,
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(globalPath, 'utf8')).toBe(source);

    writeFileSync(outputPath, 'keep-me');
    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    await invoke();
    expect(readFileSync(outputPath, 'utf8')).toBe('keep-me');
    expect(stderr).toContain('config_migration_destination_exists');
    expect(process.exitCode).toBe(1);

    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    await invoke('--force');
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
      version: 2,
    });
    expect(process.exitCode).toBeUndefined();

    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
      '--output',
      globalPath,
      '--force',
    ]);
    expect(readFileSync(globalPath, 'utf8')).toBe(source);
    expect(stderr).toContain('config_migration_source_overwrite_refused');
    expect(process.exitCode).toBe(1);
  });

  it('refuses to persist a merged project preview', async () => {
    const globalPath = join(directory, 'global-v1.json');
    const projectPath = join(directory, 'project-v1.json');
    const outputPath = join(directory, 'merged-v2.json');
    writeFileSync(globalPath, JSON.stringify(v1()));
    writeFileSync(
      projectPath,
      JSON.stringify({ version: 1, defaults: { maxParallel: 2 } }),
    );

    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
      '--project',
      projectPath,
      '--output',
      outputPath,
    ]);

    expect(stdout).toBe('');
    expect(stderr).toContain('config_migration_project_write_refused');
    expect(() => readFileSync(outputPath, 'utf8')).toThrow();
    expect(process.exitCode).toBe(1);
  });

  it('refuses a symlink alias to the global source even with force', async () => {
    if (process.platform === 'win32') return;
    const globalPath = join(directory, 'global-v1.json');
    const outputAlias = join(directory, 'source-alias.json');
    const source = JSON.stringify(v1());
    writeFileSync(globalPath, source);
    symlinkSync(globalPath, outputAlias);

    await program().parseAsync([
      'node',
      'librarium',
      'config',
      'migrate',
      '--from',
      globalPath,
      '--output',
      outputAlias,
      '--force',
    ]);

    expect(stdout).toBe('');
    expect(stderr).toContain('config_migration_source_overwrite_refused');
    expect(readFileSync(globalPath, 'utf8')).toBe(source);
    expect(readFileSync(outputAlias, 'utf8')).toBe(source);
    expect(process.exitCode).toBe(1);
  });

  it('reports the Windows owner-only preflight failure without creating output', async () => {
    const globalPath = join(directory, 'global-v1.json');
    const outputPath = join(directory, 'windows-output', 'config-v2.json');
    writeFileSync(globalPath, JSON.stringify(v1()));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = 'relative-system-root';
    try {
      await program().parseAsync([
        'node',
        'librarium',
        'config',
        'migrate',
        '--from',
        globalPath,
        '--output',
        outputPath,
      ]);
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
    }

    expect(stdout).toBe('');
    expect(stderr).toContain('config_migration_write_failed');
    expect(stderr).toContain(
      'Owner-only config saves require verified Windows ACL support.',
    );
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(dirname(outputPath))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe('config menu limit validation', () => {
  const { limitBounds, validateBoundedIntegerInput } = configCommandInternals;

  it('uses canonical field-specific maxima', () => {
    expect(limitBounds).toEqual({
      maxParallel: { min: 1, max: 64 },
      timeout: { min: 1, max: 604_800 },
      asyncTimeout: { min: 1, max: 604_800 },
      asyncPollInterval: { min: 1, max: 300 },
    });
  });

  it.each(Object.entries(limitBounds))(
    'rejects out-of-bounds %s menu values',
    (_field, bounds) => {
      expect(
        validateBoundedIntegerInput(String(bounds.min), bounds.min, bounds),
      ).toBeUndefined();
      expect(
        validateBoundedIntegerInput(String(bounds.max), bounds.min, bounds),
      ).toBeUndefined();
      expect(
        validateBoundedIntegerInput(String(bounds.min - 1), bounds.min, bounds),
      ).toContain(`${bounds.min}`);
      expect(
        validateBoundedIntegerInput(String(bounds.max + 1), bounds.min, bounds),
      ).toContain(`${bounds.max}`);
      expect(validateBoundedIntegerInput('1.5', bounds.min, bounds)).toContain(
        `${bounds.max}`,
      );
    },
  );

  it('does not accept a blank prompt when the existing value is invalid', () => {
    expect(
      validateBoundedIntegerInput(
        '',
        limitBounds.maxParallel.max + 1,
        limitBounds.maxParallel,
      ),
    ).toContain('64');
  });
});
