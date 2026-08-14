import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const installer = join(process.cwd(), 'scripts/install.sh');
const VERSION = '2.0.0-rc.1';

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarium-installer-'));
  roots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function ordinaryCandidate(path: string, version = VERSION): void {
  executable(
    path,
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' ${JSON.stringify(
      version,
    )}; else exit 0; fi\n`,
  );
}

function runInstaller(input: {
  readonly root: string;
  readonly candidate: string;
  readonly checksum?: string;
  readonly version?: string;
}) {
  return spawnSync('sh', [installer], {
    cwd: input.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LIBRARIUM_INSTALL_DIR: input.root,
      LIBRARIUM_CANDIDATE: input.candidate,
      LIBRARIUM_SHA256: input.checksum ?? sha256(input.candidate),
      LIBRARIUM_VERSION: input.version ?? VERSION,
    },
  });
}

function expectNoTransactionFiles(root: string): void {
  expect(
    readdirSync(root).filter((name) =>
      /^\.librarium\.(?:stage|backup)\./.test(name),
    ),
  ).toEqual([]);
}

describe.skipIf(process.platform === 'win32')(
  'standalone installer local candidate',
  () => {
    it('installs only the exact checksum and version', () => {
      const root = fixtureRoot();
      const candidate = join(root, 'candidate');
      ordinaryCandidate(candidate);
      const result = runInstaller({ root, candidate });
      expect(result.status, result.stderr).toBe(0);
      expect(sha256(join(root, 'librarium'))).toBe(sha256(candidate));
      expectNoTransactionFiles(root);
    });

    it('preserves the prior install on checksum failure', () => {
      const root = fixtureRoot();
      const destination = join(root, 'librarium');
      const candidate = join(root, 'candidate');
      ordinaryCandidate(destination, '1.9.9-rc.1');
      ordinaryCandidate(candidate);
      const prior = readFileSync(destination);
      const result = runInstaller({
        root,
        candidate,
        checksum: '0'.repeat(64),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('checksum mismatch');
      expect(readFileSync(destination)).toEqual(prior);
      expectNoTransactionFiles(root);
    });

    it('preserves the prior install on staged version failure', () => {
      const root = fixtureRoot();
      const destination = join(root, 'librarium');
      const candidate = join(root, 'candidate');
      ordinaryCandidate(destination, '1.9.9-rc.1');
      ordinaryCandidate(candidate, '2.0.0-rc.2');
      const prior = readFileSync(destination);
      const result = runInstaller({ root, candidate });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Candidate version mismatch');
      expect(readFileSync(destination)).toEqual(prior);
      expectNoTransactionFiles(root);
    });

    it('atomically restores the prior install after post-move failure', () => {
      const root = fixtureRoot();
      const destination = join(root, 'librarium');
      const candidate = join(root, 'candidate');
      ordinaryCandidate(destination, '1.9.9-rc.1');
      executable(
        candidate,
        `#!/bin/sh\ncase "$0" in */.librarium.stage.*) printf '%s\\n' ${JSON.stringify(
          VERSION,
        )} ;; *) exit 17 ;; esac\n`,
      );
      const prior = readFileSync(destination);
      const result = runInstaller({ root, candidate });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('post-move verification');
      expect(readFileSync(destination)).toEqual(prior);
      expectNoTransactionFiles(root);
    });

    it('rejects symlink candidates and incomplete local authority', () => {
      const root = fixtureRoot();
      const real = join(root, 'real-candidate');
      const linked = join(root, 'linked-candidate');
      ordinaryCandidate(real);
      symlinkSync(real, linked);
      const linkedResult = runInstaller({ root, candidate: linked });
      expect(linkedResult.status).not.toBe(0);
      expect(linkedResult.stderr).toContain('not a symlink');

      const incomplete = spawnSync('sh', [installer], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          LIBRARIUM_INSTALL_DIR: root,
          LIBRARIUM_CANDIDATE: real,
          LIBRARIUM_VERSION: VERSION,
          LIBRARIUM_SHA256: '',
        },
      });
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toContain('require LIBRARIUM_CANDIDATE');
    });
  },
);
