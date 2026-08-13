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
  readonly replaceAtomically: (
    temporaryPath: string,
    destinationPath: string,
    content: string,
    mutationStage?: WindowsMutationStage,
  ) => void;
}

type WindowsMutationStage =
  | 'initial-verify-to-write'
  | 'write-to-final-verify'
  | 'final-verify-to-rename'
  | 'failure-cleanup';

interface SafeWriteFileOptions {
  readonly mode?: number;
  /** Require owner-only permissions before the rename commits the file. */
  readonly ownerOnly?: boolean;
  /** Internal mutation-test seam. Production callers must use the default. */
  readonly windowsAcl?: WindowsOwnerOnlyAcl;
  /** Native Windows regression hook. Never set in production. */
  readonly windowsMutationStage?: WindowsMutationStage;
}

const WINDOWS_ACL_TIMEOUT_MS = 15_000;
const WINDOWS_ACL_MAX_BUFFER = 64 * 1024;

const WINDOWS_NATIVE_FILE_TYPE = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class LibrariumNativeFile {
  private enum FILE_INFO_BY_HANDLE_CLASS {
    FileRenameInfo = 3,
    FileDispositionInfo = 4
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(
    SafeFileHandle handle,
    FILE_INFO_BY_HANDLE_CLASS informationClass,
    IntPtr information,
    uint bufferSize
  );

  public static void Rename(SafeFileHandle handle, string destination) {
    byte[] name = Encoding.Unicode.GetBytes(destination);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = rootOffset + IntPtr.Size;
    int nameOffset = lengthOffset + sizeof(uint);
    int size = nameOffset + name.Length;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
      Marshal.WriteInt32(buffer, 0, 1);
      Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
      Marshal.WriteInt32(buffer, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
      if (!SetFileInformationByHandle(handle, FILE_INFO_BY_HANDLE_CLASS.FileRenameInfo, buffer, (uint)size)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  public static void DeleteOnClose(SafeFileHandle handle) {
    IntPtr buffer = Marshal.AllocHGlobal(1);
    try {
      Marshal.WriteByte(buffer, 0, 1);
      if (!SetFileInformationByHandle(handle, FILE_INFO_BY_HANDLE_CLASS.FileDispositionInfo, buffer, 1)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }
}
`;

const WINDOWS_ASSERT_OWNER_ONLY_ACL_SUPPORT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_FILE_TYPE}
'@
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
[void][LibrariumNativeFile]
[Console]::Out.Write('supported')
`;

const WINDOWS_REPLACE_OWNER_ONLY_FILE = `
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$temporaryPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.temporaryPath))
$destinationPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.destinationPath))
$content = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.content))
$mutationStage = $payload.mutationStage
$mutationConfirmed = $false

Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_FILE_TYPE}
'@

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

function Assert-OwnerOnlyAcl([IO.FileStream] $stream) {
  $verifiedAcl = $stream.GetAccessControl()
  $owner = $verifiedAcl.GetOwner([Security.Principal.SecurityIdentifier])
  $rules = @($verifiedAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $fullControl = [int][Security.AccessControl.FileSystemRights]::FullControl
  $noneInheritance = [Security.AccessControl.InheritanceFlags]::None
  $nonePropagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow

  if ($owner.Value -ne $sid.Value) { throw 'The file owner is not the current user.' }
  if (-not $verifiedAcl.AreAccessRulesProtected) { throw 'The file DACL is not protected.' }
  if ($rules.Count -ne 1) { throw 'The file DACL does not contain exactly one ACE.' }
  $verifiedRule = $rules[0]
  if ($verifiedRule.IdentityReference.Value -ne $sid.Value) { throw 'The file ACE is not for the current user.' }
  if ($verifiedRule.IsInherited) { throw 'The file ACE is inherited.' }
  if ($verifiedRule.AccessControlType -ne $allow) { throw 'The file ACE is not an allow rule.' }
  if ([int]$verifiedRule.FileSystemRights -ne $fullControl) { throw 'The file ACE is not full control.' }
  if ($verifiedRule.InheritanceFlags -ne $noneInheritance) { throw 'The file ACE has inheritance flags.' }
  if ($verifiedRule.PropagationFlags -ne $nonePropagation) { throw 'The file ACE has propagation flags.' }
}

function Assert-NamespaceSwapBlocked([string] $stage) {
  if ($mutationStage -ne $stage) { return }
  $heldPath = "$temporaryPath.swap"
  $moveBlocked = $false
  try {
    [IO.File]::Move($temporaryPath, $heldPath)
  } catch [IO.IOException] {
    $win32Error = $_.Exception.HResult -band 0xffff
    if ($win32Error -ne 32) { throw }
    $moveBlocked = $true
    $script:mutationConfirmed = $true
  }
  if (-not $moveBlocked) {
    [IO.File]::WriteAllText($temporaryPath, 'attacker replacement')
    throw "Namespace substitution unexpectedly succeeded at $stage."
  }
}

$stream = $null
$committed = $false
try {
  $stream = New-Object IO.FileStream -ArgumentList @(
    $temporaryPath,
    [IO.FileMode]::CreateNew,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [IO.FileShare]::None,
    4096,
    [IO.FileOptions]::None,
    $acl
  )
  Assert-OwnerOnlyAcl $stream
  Assert-NamespaceSwapBlocked 'initial-verify-to-write'

  $bytes = [Text.Encoding]::UTF8.GetBytes($content)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
  Assert-NamespaceSwapBlocked 'write-to-final-verify'
  Assert-OwnerOnlyAcl $stream
  Assert-NamespaceSwapBlocked 'final-verify-to-rename'

  if ($null -ne $mutationStage -and $mutationStage -ne 'failure-cleanup' -and -not $mutationConfirmed) {
    throw "The namespace mutation was not tested at $mutationStage."
  }

  if ($mutationStage -eq 'failure-cleanup') {
    throw 'Injected failure before handle-bound cleanup.'
  }

  [LibrariumNativeFile]::Rename($stream.SafeFileHandle, $destinationPath)
  $committed = $true
  Assert-OwnerOnlyAcl $stream
  $stream.Dispose()
  $stream = $null
  [Console]::Out.Write('replaced')
} catch {
  try {
    if ($null -ne $stream -and -not $committed) {
      try {
        Assert-NamespaceSwapBlocked 'failure-cleanup'
        if ($mutationStage -eq 'failure-cleanup' -and -not $mutationConfirmed) {
          throw 'The namespace mutation was not tested during failure cleanup.'
        }
      } finally {
        [LibrariumNativeFile]::DeleteOnClose($stream.SafeFileHandle)
      }
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
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

function runWindowsOwnerOnlyReplace(
  temporaryPath: string,
  destinationPath: string,
  content: string,
  mutationStage?: WindowsMutationStage,
): string {
  return execFileSync(
    windowsPowerShellExecutable(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_REPLACE_OWNER_ONLY_FILE, 'utf16le').toString(
        'base64',
      ),
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify({
        temporaryPath: Buffer.from(temporaryPath, 'utf8').toString('base64'),
        destinationPath: Buffer.from(destinationPath, 'utf8').toString(
          'base64',
        ),
        content: Buffer.from(content, 'utf8').toString('base64'),
        mutationStage,
      }),
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

/** Replace a destination while retaining one protected temp-file handle. */
function replaceWindowsOwnerOnlyFile(
  temporaryPath: string,
  destinationPath: string,
  content: string,
  mutationStage?: WindowsMutationStage,
): void {
  if (
    runWindowsOwnerOnlyReplace(
      temporaryPath,
      destinationPath,
      content,
      mutationStage,
    ) !== 'replaced'
  ) {
    throw new Error('Windows owner-only replacement returned no proof.');
  }
}

/** Read back and verify the exact owner-only Windows security descriptor. */
export function verifyWindowsOwnerOnlyAcl(path: string): void {
  if (runWindowsAclScript(path, WINDOWS_VERIFY_OWNER_ONLY_ACL) !== 'verified') {
    throw new Error('Windows owner-only ACL verification returned no proof.');
  }
}

const DEFAULT_WINDOWS_ACL: WindowsOwnerOnlyAcl = {
  replaceAtomically: replaceWindowsOwnerOnlyFile,
};

/**
 * Atomically write a file by writing to an exclusive sibling temp file and
 * renaming it over the destination.
 *
 * Owner-only writes establish and verify their Unix mode or Windows DACL on
 * the empty temp file before writing content. Windows retains the creation
 * handle through the final ACL check and handle-bound rename.
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
      // The Windows transaction retains the creation handle through ACL
      // verification, write, handle-bound rename, and failure disposal. Node
      // must never act on the temporary pathname after this call begins.
      windowsAcl.replaceAtomically(
        tmp,
        path,
        content,
        options.windowsMutationStage,
      );
      return;
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
