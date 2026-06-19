import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import {
  type CredentialContext,
  keychainCredentialName,
} from './core/credentials.js';

const KEYCHAIN_SERVICE = 'librarium';
const MACOS_SECURITY = '/usr/bin/security';

export function isKeychainAvailable(): boolean {
  return platform() === 'darwin' && existsSync(MACOS_SECURITY);
}

export function readKeychainCredential(name: string): string | undefined {
  if (!isKeychainAvailable()) return undefined;

  const result = spawnSync(
    MACOS_SECURITY,
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) return undefined;
  const value = result.stdout.replace(/\n$/, '');
  return value.length > 0 ? value : undefined;
}

export function writeKeychainCredential(name: string, value: string): void {
  if (!isKeychainAvailable()) {
    throw new Error('OS keychain storage is not available on this system.');
  }

  const result = spawnSync(
    MACOS_SECURITY,
    [
      'add-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      name,
      '-w',
      value,
      '-U',
    ],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      detail
        ? `Failed to store keychain credential: ${detail}`
        : 'Failed to store keychain credential.',
    );
  }
}

export function deleteKeychainCredential(name: string): void {
  if (!isKeychainAvailable()) return;
  spawnSync(
    MACOS_SECURITY,
    ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name],
    { encoding: 'utf8' },
  );
}

export function createNodeCredentialContext(
  env: NodeJS.ProcessEnv = process.env,
): CredentialContext {
  return {
    env,
    resolveCredential: (value) => {
      const name = keychainCredentialName(value);
      return name ? readKeychainCredential(name) : undefined;
    },
  };
}
