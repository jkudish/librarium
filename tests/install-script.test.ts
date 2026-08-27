import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
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

function runRemoteInstaller(input: {
  readonly root: string;
  readonly candidate: string;
  readonly manifest: string;
  readonly fingerprint?: string;
}) {
  const bin = join(input.root, 'fake-bin');
  mkdirSync(bin);
  executable(
    join(bin, 'curl'),
    '#!/bin/sh\nout=""\nurl=""\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    *) url="$1"; shift ;;\n  esac\ndone\ncase "$url" in\n  */SHA256SUMS) cp "$FIXTURE_MANIFEST" "$out" ;;\n  *) cp "$FIXTURE_CANDIDATE" "$out" ;;\nesac\n',
  );
  return spawnSync('sh', [installer], {
    cwd: input.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FIXTURE_CANDIDATE: input.candidate,
      FIXTURE_MANIFEST: input.manifest,
      LIBRARIUM_INSTALL_DIR: input.root,
      LIBRARIUM_VERSION: VERSION,
      LIBRARIUM_CANDIDATE_SHA: 'a'.repeat(40),
      LIBRARIUM_CANDIDATE_FINGERPRINT:
        input.fingerprint ?? `sha256:${'b'.repeat(64)}`,
      LIBRARIUM_CANDIDATE: '',
      LIBRARIUM_SHA256: '',
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
    it('marks the transaction replaced before the atomic move', () => {
      const source = readFileSync(installer, 'utf8');
      expect(source.indexOf('  REPLACED=1\n')).toBeLessThan(
        source.indexOf('  privileged mv -f "$STAGE_FILE" "$DESTINATION"\n'),
      );
    });

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

    it('installs remote bytes only through the identity-qualified checksum manifest', () => {
      const root = fixtureRoot();
      const candidate = join(root, 'remote-candidate');
      const manifest = join(root, 'SHA256SUMS.fixture');
      ordinaryCandidate(candidate);
      writeFileSync(
        manifest,
        `# librarium-candidate-sha ${'a'.repeat(40)}\n# librarium-candidate-fingerprint sha256:${'b'.repeat(64)}\n# librarium-version ${VERSION}\n${sha256(candidate)}  librarium-linux-x64\n`,
      );
      const result = runRemoteInstaller({ root, candidate, manifest });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, 'librarium'))).toEqual(
        readFileSync(candidate),
      );
      expectNoTransactionFiles(root);
    });

    it('preserves the prior install on remote manifest identity mismatch', () => {
      const root = fixtureRoot();
      const destination = join(root, 'librarium');
      const candidate = join(root, 'remote-candidate');
      const manifest = join(root, 'SHA256SUMS.fixture');
      ordinaryCandidate(destination, '1.9.9-rc.1');
      ordinaryCandidate(candidate);
      writeFileSync(
        manifest,
        `# librarium-candidate-sha ${'a'.repeat(40)}\n# librarium-candidate-fingerprint sha256:${'b'.repeat(64)}\n# librarium-version ${VERSION}\n${sha256(candidate)}  librarium-linux-x64\n`,
      );
      const prior = readFileSync(destination);
      const result = runRemoteInstaller({
        root,
        candidate,
        manifest,
        fingerprint: `sha256:${'c'.repeat(64)}`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('candidate fingerprint mismatch');
      expect(readFileSync(destination)).toEqual(prior);
      expectNoTransactionFiles(root);
    });
  },
);
