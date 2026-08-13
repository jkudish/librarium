import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { win32 } from 'node:path';

interface WindowsOwnerOnlyAcl {
  readonly createExclusive: (path: string, markCreated: () => void) => void;
  readonly verify: (path: string) => void;
}

interface SafeWriteFileOptions {
  readonly mode?: number;
  /** Require owner-only permissions before the rename commits the file. */
  readonly ownerOnly?: boolean;
  /** Internal mutation-test seam. Production callers must use the default. */
  readonly windowsAcl?: WindowsOwnerOnlyAcl;
}

const WINDOWS_ACL_TIMEOUT_MS = 15_000;
const WINDOWS_ACL_MAX_BUFFER = 64 * 1024;

const WINDOWS_ASSERT_OWNER_ONLY_ACL_SUPPORT = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'The current Windows identity has no user SID.' }
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$constructor = [IO.FileStream].GetConstructor(@(
  [string],
  [IO.FileMode],
  [Security.AccessControl.FileSystemRights],
  [IO.FileShare],
  [int],
  [IO.FileOptions],
  [Security.AccessControl.FileSecurity]
))
if ($null -eq $constructor) { throw 'The secure FileStream constructor is unavailable.' }
[Console]::Out.Write('supported')
`;

const WINDOWS_CREATE_OWNER_ONLY_FILE = `
$ErrorActionPreference = 'Stop'
$encodedPath = [Console]::In.ReadToEnd()
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'The current Windows identity has no user SID.' }

$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
  $sid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)

$stream = $null
$created = $false
try {
  $stream = New-Object IO.FileStream -ArgumentList @(
    $path,
    [IO.FileMode]::CreateNew,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [IO.FileShare]::None,
    4096,
    [IO.FileOptions]::None,
    $acl
  )
  $created = $true
  $stream.Dispose()
  $stream = $null
  [Console]::Out.Write('created')
} catch {
  try {
    if ($null -ne $stream) { $stream.Dispose() }
  } finally {
    if ($created) { [IO.File]::Delete($path) }
  }
  throw
}
`;

const WINDOWS_VERIFY_OWNER_ONLY_ACL = `
$ErrorActionPreference = 'Stop'
$encodedPath = [Console]::In.ReadToEnd()
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'The current Windows identity has no user SID.' }

$acl = [IO.File]::GetAccessControl($path)
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$fullControl = [int][Security.AccessControl.FileSystemRights]::FullControl
$noneInheritance = [Security.AccessControl.InheritanceFlags]::None
$nonePropagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow

if ($owner.Value -ne $sid.Value) { throw 'The file owner is not the current user.' }
if (-not $acl.AreAccessRulesProtected) { throw 'The file DACL is not protected.' }
if ($rules.Count -ne 1) { throw 'The file DACL does not contain exactly one ACE.' }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'The file ACE is not for the current user.' }
if ($rule.IsInherited) { throw 'The file ACE is inherited.' }
if ($rule.AccessControlType -ne $allow) { throw 'The file ACE is not an allow rule.' }
if ([int]$rule.FileSystemRights -ne $fullControl) { throw 'The file ACE is not full control.' }
if ($rule.InheritanceFlags -ne $noneInheritance) { throw 'The file ACE has inheritance flags.' }
if ($rule.PropagationFlags -ne $nonePropagation) { throw 'The file ACE has propagation flags.' }

[Console]::Out.Write('verified')
`;

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw new Error('A valid Windows system root is required.');
  }
  return win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function runWindowsAclScript(path: string, script: string): string {
  return execFileSync(
    windowsPowerShellExecutable(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      input: Buffer.from(path, 'utf8').toString('base64'),
      maxBuffer: WINDOWS_ACL_MAX_BUFFER,
      shell: false,
      timeout: WINDOWS_ACL_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}

/** Fail before filesystem mutation when the required inbox ACL tool is absent. */
export function assertWindowsOwnerOnlyAclSupport(): void {
  if (process.platform !== 'win32') return;
  if (!existsSync(windowsPowerShellExecutable())) {
    throw new Error('Windows PowerShell is required for owner-only writes.');
  }
  if (
    runWindowsAclScript('', WINDOWS_ASSERT_OWNER_ONLY_ACL_SUPPORT) !==
    'supported'
  ) {
    throw new Error('Windows owner-only ACL preflight returned no proof.');
  }
}

/** Exclusively create a file with a protected current-user-only DACL. */
export function createWindowsOwnerOnlyFile(path: string): void {
  if (runWindowsAclScript(path, WINDOWS_CREATE_OWNER_ONLY_FILE) !== 'created') {
    throw new Error('Windows owner-only creation returned no proof.');
  }
}

/** Read back and verify the exact owner-only Windows security descriptor. */
export function verifyWindowsOwnerOnlyAcl(path: string): void {
  if (runWindowsAclScript(path, WINDOWS_VERIFY_OWNER_ONLY_ACL) !== 'verified') {
    throw new Error('Windows owner-only ACL verification returned no proof.');
  }
}

const DEFAULT_WINDOWS_ACL: WindowsOwnerOnlyAcl = {
  createExclusive: (path, markCreated) => {
    createWindowsOwnerOnlyFile(path);
    markCreated();
  },
  verify: verifyWindowsOwnerOnlyAcl,
};

/**
 * Atomically write a file by writing to an exclusive sibling temp file and
 * renaming it over the destination.
 *
 * Owner-only writes establish and verify their Unix mode or Windows DACL on
 * the empty temp file before writing content, then verify again before rename.
 */
export function safeWriteFile(
  path: string,
  content: string,
  options?: SafeWriteFileOptions,
): void {
  const createMode = options?.ownerOnly ? 0o600 : options?.mode;
  if (
    options?.ownerOnly &&
    options.mode !== undefined &&
    options.mode !== 0o600
  ) {
    throw new Error('Owner-only writes require mode 600.');
  }
  const tmp = `${path}.tmp.${randomUUID()}`;
  let descriptor: number | undefined;
  let created = false;

  try {
    if (options?.ownerOnly && process.platform === 'win32') {
      const windowsAcl = options.windowsAcl ?? DEFAULT_WINDOWS_ACL;
      // FileMode.CreateNew plus FileSecurity applies the protected DACL in the
      // same OS create operation. No broadly inherited handle exists first.
      windowsAcl.createExclusive(tmp, () => {
        created = true;
      });
      if (!created) {
        throw new Error('Windows owner-only creation returned no proof.');
      }
      windowsAcl.verify(tmp);
      descriptor = openSync(tmp, 'r+');
    } else {
      // wx makes creation exclusive even if a random-name collision or a
      // pre-existing symlink is present. Track ownership so a collision never
      // causes cleanup to delete a path that this call did not create.
      descriptor = openSync(tmp, 'wx', createMode);
      created = true;
      if (options?.ownerOnly) {
        const expectedMode = 0o600;
        // The creation mode is subject to umask. Force and verify the exact
        // owner-only bits while the file is still empty and uncommitted.
        chmodSync(tmp, expectedMode);
        if ((statSync(tmp).mode & 0o777) !== expectedMode) {
          throw new Error(
            `Temporary file mode must be ${expectedMode.toString(8)}.`,
          );
        }
      }
    }

    writeFileSync(descriptor, content, { encoding: 'utf8' });
    closeSync(descriptor);
    descriptor = undefined;

    if (options?.ownerOnly && process.platform === 'win32') {
      (options.windowsAcl ?? DEFAULT_WINDOWS_ACL).verify(tmp);
    }

    renameSync(tmp, path);
    created = false;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* preserve the original failure */
      }
    }
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {
        /* preserve the original failure */
      }
    }
    throw error;
  }
}
