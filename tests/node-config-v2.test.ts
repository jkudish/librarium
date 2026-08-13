import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibrariumConfigV2 } from '../src/core/config-v2.js';
import {
  safeWriteFile,
  verifyWindowsOwnerOnlyAcl,
} from '../src/core/fs-utils.js';
import {
  ConfigV2FileError,
  loadConfigV2,
  projectConfigV2Path,
  saveConfigV2,
} from '../src/node-config-v2.js';

function config(): LibrariumConfigV2 {
  return {
    version: 2,
    execution_defaults: {
      mode: 'sync',
      max_concurrency: 2,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 60_000,
      poll_interval_ms: 5_000,
    },
    providers: { exa: { enabled: true } },
    custom_providers: {},
    trusted_provider_ids: [],
    groups: { 'custom:team': ['exa/search'] },
    runtime: {
      output_dir: './agents/librarium',
      llm_web_search: true,
    },
  };
}

function setNativeWindowsInheritedAcl(path: string): void {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) {
    throw new Error('SystemRoot is required for native Windows ACL tests.');
  }
  const script = `
$ErrorActionPreference = 'Stop'
$encodedPath = [Console]::In.ReadToEnd()
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$everyone = New-Object Security.Principal.SecurityIdentifier 'S-1-1-0'
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule -ArgumentList @(
  $sid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inherit,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule -ArgumentList @(
  $everyone,
  [Security.AccessControl.FileSystemRights]::ReadAndExecute,
  $inherit,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)))
[IO.Directory]::SetAccessControl($path, $acl)
`;
  execFileSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      input: Buffer.from(path, 'utf8').toString('base64'),
      shell: false,
      windowsHide: true,
    },
  );
}

function addNativeWindowsEveryoneRule(path: string): void {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) {
    throw new Error('SystemRoot is required for native Windows ACL tests.');
  }
  const script = `
$ErrorActionPreference = 'Stop'
$encodedPath = [Console]::In.ReadToEnd()
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
$everyone = New-Object Security.Principal.SecurityIdentifier 'S-1-1-0'
$acl = [IO.File]::GetAccessControl($path)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule -ArgumentList @(
  $everyone,
  [Security.AccessControl.FileSystemRights]::Read,
  [Security.AccessControl.AccessControlType]::Allow
)))
[IO.File]::SetAccessControl($path, $acl)
`;
  execFileSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      input: Buffer.from(path, 'utf8').toString('base64'),
      shell: false,
      windowsHide: true,
    },
  );
}

describe('explicit Node v2 config files', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'librarium-config-v2-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads and migrates without rewriting either source file', () => {
    const globalPath = join(directory, 'config.json');
    const projectPath = join(directory, '.librarium.json');
    const global = JSON.stringify(config(), null, 2);
    const project = JSON.stringify({
      version: 2,
      execution_defaults: { max_concurrency: 5 },
    });
    writeFileSync(globalPath, global);
    writeFileSync(projectPath, project);

    const result = loadConfigV2({
      global_path: globalPath,
      project_path: projectPath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.execution_defaults.max_concurrency).toBe(5);
    }
    expect(readFileSync(globalPath, 'utf8')).toBe(global);
    expect(readFileSync(projectPath, 'utf8')).toBe(project);
  });

  it.each([
    ['perplexity-sonar', 'perplexity-sonar-pro'],
    ['perplexity-deep', 'perplexity-sonar-deep'],
    ['openai-deep', 'openai-research'],
    ['openai-deep-o3', 'openai-research'],
  ])(
    'preserves retired native v2 group guidance for %s',
    (retired, replacement) => {
      const globalPath = join(directory, `${retired}.json`);
      writeFileSync(
        globalPath,
        JSON.stringify({
          ...config(),
          groups: { 'custom:retired': [retired] },
        }),
      );

      const result = loadConfigV2({ global_path: globalPath });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'config_group_member_alias_removed',
          path: '/groups/custom:retired/0',
          message: expect.stringContaining(`use "${replacement}"`),
        }),
      );
      expect(result.issues).not.toContainEqual(
        expect.objectContaining({
          code: 'config_group_member_unknown',
          path: '/groups/custom:retired/0',
        }),
      );
    },
  );

  it('returns safe path-addressed JSON diagnostics', () => {
    const globalPath = join(directory, 'config.json');
    const secret = 'supersecret-api-key';
    writeFileSync(globalPath, `{"api_key":${secret}}`);
    const result = loadConfigV2({ global_path: globalPath });
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'config_json_invalid',
          path: '/global',
          message: 'Invalid JSON.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('distinguishes file-read failures from malformed JSON without leaking paths', () => {
    const missingPath = join(directory, 'missing-config.json');
    const result = loadConfigV2({ global_path: missingPath });
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'config_file_read_failed',
          path: '/global',
          message: 'Unable to read configuration file.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(missingPath);
  });

  it('validates before an atomic owner-only save', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'nested', 'config.json');
    saveConfigV2(config(), { path });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(config());
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(directory, 'nested'))).toEqual(['config.json']);
  });

  it('verifies owner-only mode after a restrictive umask before rename', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'umask', 'config.json');
    mkdirSync(dirname(path), { recursive: true });
    const previousUmask = process.umask(0o400);
    try {
      saveConfigV2(config(), { path });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('rejects missing Windows ACL support before creating directories', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = 'relative-system-root';
    const path = join(directory, 'windows-preflight', 'config.json');
    try {
      expect(() => saveConfigV2(config(), { path })).toThrow(ConfigV2FileError);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(dirname(path))).toBe(false);
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
    }
  });

  it('requires Windows ACL verification before bytes and replacement', () => {
    if (process.platform !== 'win32') {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    }
    const path = join(directory, 'windows-order.json');
    const observed: string[] = [];

    safeWriteFile(path, 'owner-only-content', {
      mode: 0o600,
      ownerOnly: true,
      windowsAcl: {
        createExclusive(tempPath, markCreated) {
          writeFileSync(tempPath, '', { flag: 'wx' });
          markCreated();
          observed.push(`created:${readFileSync(tempPath, 'utf8')}`);
        },
        verify(tempPath) {
          observed.push(`verified:${readFileSync(tempPath, 'utf8')}`);
        },
      },
    });

    expect(observed).toEqual([
      'created:',
      'verified:',
      'verified:owner-only-content',
    ]);
    expect(readFileSync(path, 'utf8')).toBe('owner-only-content');
    expect(readdirSync(directory)).toEqual(['windows-order.json']);
  });

  it('cleans a Windows temp file when ACL application fails', () => {
    if (process.platform !== 'win32') {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    }
    const path = join(directory, 'windows-apply-failure.json');

    expect(() =>
      safeWriteFile(path, 'must-not-commit', {
        mode: 0o600,
        ownerOnly: true,
        windowsAcl: {
          createExclusive(tempPath, markCreated) {
            writeFileSync(tempPath, '', { flag: 'wx' });
            markCreated();
            throw new Error('injected ACL application failure');
          },
          verify() {
            throw new Error('verification must not run');
          },
        },
      }),
    ).toThrow('injected ACL application failure');
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('does not unlink a colliding Windows temp path it did not create', () => {
    if (process.platform !== 'win32') {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    }
    const path = join(directory, 'windows-create-collision.json');
    let collisionPath = '';

    expect(() =>
      safeWriteFile(path, 'must-not-commit', {
        mode: 0o600,
        ownerOnly: true,
        windowsAcl: {
          createExclusive(tempPath) {
            collisionPath = tempPath;
            writeFileSync(tempPath, 'someone-else');
            throw new Error('injected exclusive-create collision');
          },
          verify() {
            throw new Error('verification must not run');
          },
        },
      }),
    ).toThrow('injected exclusive-create collision');
    expect(readFileSync(collisionPath, 'utf8')).toBe('someone-else');
    expect(existsSync(path)).toBe(false);
  });

  it('keeps the destination and cleans the Windows temp after verification failure', () => {
    if (process.platform !== 'win32') {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    }
    const path = join(directory, 'windows-verify-failure.json');
    writeFileSync(path, 'original');
    let verifications = 0;

    expect(() =>
      safeWriteFile(path, 'must-not-commit', {
        mode: 0o600,
        ownerOnly: true,
        windowsAcl: {
          createExclusive(tempPath, markCreated) {
            writeFileSync(tempPath, '', { flag: 'wx' });
            markCreated();
          },
          verify() {
            verifications += 1;
            if (verifications === 2) {
              throw new Error('injected ACL verification failure');
            }
          },
        },
      }),
    ).toThrow('injected ACL verification failure');
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(readdirSync(directory)).toEqual(['windows-verify-failure.json']);
  });

  it('keeps the destination and cleans the Windows temp after first verification failure', () => {
    if (process.platform !== 'win32') {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    }
    const path = join(directory, 'windows-first-verify-failure.json');
    writeFileSync(path, 'original');

    expect(() =>
      safeWriteFile(path, 'must-not-write', {
        mode: 0o600,
        ownerOnly: true,
        windowsAcl: {
          createExclusive(tempPath, markCreated) {
            writeFileSync(tempPath, '', { flag: 'wx' });
            markCreated();
          },
          verify() {
            throw new Error('injected first ACL verification failure');
          },
        },
      }),
    ).toThrow('injected first ACL verification failure');
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(readdirSync(directory)).toEqual([
      'windows-first-verify-failure.json',
    ]);
  });

  it('preserves ordinary mode-only atomic writes on every platform', () => {
    const path = join(directory, 'ordinary-write.txt');
    safeWriteFile(path, 'legacy-compatible', { mode: 0o600 });
    expect(readFileSync(path, 'utf8')).toBe('legacy-compatible');
  });

  it('atomically replaces an existing config without leaving temp files', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'config.json');
    saveConfigV2(config(), { path });
    const replacement: LibrariumConfigV2 = {
      ...config(),
      runtime: {
        output_dir: './replacement-runs',
        llm_web_search: false,
      },
    };

    saveConfigV2(replacement, { path });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement);
    expect(readdirSync(directory)).toEqual(['config.json']);
  });

  it('does not write an invalid v2 config', () => {
    const path = join(directory, 'config.json');
    expect(() =>
      saveConfigV2(
        {
          ...config(),
          groups: { team: ['exa/search'] },
        } as LibrariumConfigV2,
        { path },
      ),
    ).toThrow(ConfigV2FileError);
    expect(existsSync(path)).toBe(false);
  });

  it('saves and reloads the same materialized chat defaults', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'config.json');
    const source: LibrariumConfigV2 = {
      ...config(),
      providers: { claude: { enabled: true } },
      runtime: {
        output_dir: './agents/librarium',
        llm_web_search: false,
      },
    };

    saveConfigV2(source, { path });
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.providers.claude.options).toEqual({ webSearch: false });

    const loaded = loadConfigV2({ global_path: path });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.config).toEqual(saved);
  });

  it('resolves the conventional project path without reading it', () => {
    expect(projectConfigV2Path(directory)).toBe(
      join(directory, '.librarium.json'),
    );
  });
});

describe.runIf(process.platform === 'win32')(
  'native Windows owner-only ACL saves',
  () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'librarium-config-v2-windows-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('performs a Windows first write and whole-file overwrite with owner-only ACLs', () => {
      const path = join(directory, "config [owner] ' &.json");
      saveConfigV2(config(), { path });
      verifyWindowsOwnerOnlyAcl(path);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(config());

      const replacement: LibrariumConfigV2 = {
        ...config(),
        runtime: {
          output_dir: './windows-replacement-runs',
          llm_web_search: false,
        },
      };
      saveConfigV2(replacement, { path });

      verifyWindowsOwnerOnlyAcl(path);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement);
      expect(readdirSync(directory)).toEqual(["config [owner] ' &.json"]);
    });

    it('removes inherited Windows trustees from a restrictive parent ACL', () => {
      const parent = join(directory, 'restricted-inheritance');
      mkdirSync(parent);
      setNativeWindowsInheritedAcl(parent);
      const path = join(parent, 'config.json');

      saveConfigV2(config(), { path });

      verifyWindowsOwnerOnlyAcl(path);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(config());
      expect(readdirSync(parent)).toEqual(['config.json']);
    });

    it('rejects a Windows ACL after an extra trustee is added', () => {
      const path = join(directory, 'tampered-config.json');
      saveConfigV2(config(), { path });
      addNativeWindowsEveryoneRule(path);

      expect(() => verifyWindowsOwnerOnlyAcl(path)).toThrow();
    });
  },
);
