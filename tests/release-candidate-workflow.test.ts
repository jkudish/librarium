import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  homebrewInputFor,
  renderLocalHomebrewFormula,
} from '../src/node-rc-distribution-proof.js';
import {
  assertReleaseCandidateAuthority,
  assertReleaseCandidateWorkflowPolicy,
} from '../src/node-release-workflow.js';

const temporaryRoots: string[] = [];
const workflowPath = join(
  process.cwd(),
  '.github/workflows/release-candidate.yml',
);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, arguments_: readonly string[]): string {
  return execFileSync('git', [...arguments_], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function fixtureRepository(version = '2.0.0-rc.1'): {
  readonly root: string;
  readonly sha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'librarium-rc-workflow-'));
  temporaryRoots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'librarium', version }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'librarium',
        version,
        lockfileVersion: 3,
        packages: { '': { name: 'librarium', version } },
      },
      null,
      2,
    )}\n`,
  );
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'RC Workflow Fixture']);
  git(root, ['config', 'user.email', 'rc-workflow@example.invalid']);
  git(root, ['config', 'commit.gpgSign', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

describe('release-candidate workflow policy', () => {
  it('keeps a separate read-only SHA-qualified no-publication DAG', () => {
    const source = readFileSync(workflowPath, 'utf8');
    expect(() => assertReleaseCandidateWorkflowPolicy(source)).not.toThrow();
    expect(source).not.toContain('.github/workflows/release.yml');
  });

  it.each([
    [
      'permission excess',
      (source: string) => source.replace('contents: read', 'contents: write'),
    ],
    [
      'publication command',
      (source: string) => `${source}\n# npm publish is forbidden\n`,
    ],
    [
      'tag clobber',
      (source: string) => `${source}\n# git tag -f v2.0.0-rc.1\n`,
    ],
    [
      'overwritable output',
      (source: string) => source.replace('overwrite: false', 'overwrite: true'),
    ],
    [
      'non-SHA output',
      (source: string) =>
        source.replace(
          'librarium-rc-${{ needs.preflight.outputs.sha }}-package',
          'librarium-rc-package',
        ),
    ],
    [
      'missing supported runtime',
      (source: string) =>
        source.replace(
          'node-version: [22.12.0, 24, 26]',
          'node-version: [22.13.0, 24, 26]',
        ),
    ],
    [
      'mutable version input',
      (source: string) =>
        source.replace(
          '      git_sha:\n',
          '      version:\n        description: mutable\n        required: true\n      git_sha:\n',
        ),
    ],
    [
      'movable action reference',
      (source: string) =>
        source.replace(
          'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
          'actions/checkout@v6',
        ),
    ],
  ])('rejects %s policy mutation', (_label, mutate) => {
    const source = readFileSync(workflowPath, 'utf8');
    expect(() =>
      assertReleaseCandidateWorkflowPolicy(mutate(source)),
    ).toThrow();
  });

  it('rejects duplicate artifact output templates', () => {
    const source = readFileSync(workflowPath, 'utf8');
    const duplicate = `${source}\n  duplicate-proof:\n    steps:\n      - name: duplicate\n        uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n        with:\n          name: librarium-rc-\${{ needs.preflight.outputs.sha }}-package\n          overwrite: false\n`;
    expect(() => assertReleaseCandidateWorkflowPolicy(duplicate)).toThrow(
      'duplicate artifact output names',
    );
  });

  it('validates dispatch and Git authority before setup or dependency execution', () => {
    const source = readFileSync(workflowPath, 'utf8');
    const dispatch = source.indexOf(
      'Validate dispatch context before candidate code',
    );
    const gitAuthority = source.indexOf(
      'Validate Git authority before candidate code',
    );
    const setup = source.indexOf('Setup Node.js 24');
    const install = source.indexOf('Install locked dependencies');
    expect(dispatch).toBeGreaterThan(0);
    expect(gitAuthority).toBeGreaterThan(dispatch);
    expect(setup).toBeGreaterThan(gitAuthority);
    expect(install).toBeGreaterThan(setup);
    expect(source.match(/- name: Reject source mutation/g)).toHaveLength(5);
  });

  it('records the real Homebrew install result after local execution', () => {
    const source = readFileSync(workflowPath, 'utf8');
    expect(source).toContain('finalize-homebrew');
    expect(source).toContain('homebrew-result.json');
    expect(source.indexOf('brew install --formula')).toBeLessThan(
      source.indexOf('finalize-homebrew'),
    );
  });
});

describe('release-candidate protected-main authority', () => {
  it('accepts only the exact clean protected-main tip and committed RC version', () => {
    const fixture = fixtureRepository();
    expect(
      assertReleaseCandidateAuthority({
        repository_root: fixture.root,
        candidate_sha: fixture.sha,
        protected_ref: 'refs/heads/main',
        dispatch_ref: 'refs/heads/main',
        dispatch_ref_protected: 'true',
      }),
    ).toMatchObject({
      sha: fixture.sha,
      version: '2.0.0-rc.1',
      artifact_prefix: `librarium-rc-${fixture.sha}`,
    });
  });

  it.each([
    [
      'short SHA',
      (fixture: ReturnType<typeof fixtureRepository>) => ({
        candidate_sha: fixture.sha.slice(0, 12),
      }),
    ],
    [
      'wrong dispatch branch',
      (_fixture: ReturnType<typeof fixtureRepository>) => ({
        dispatch_ref: 'refs/heads/release-candidate',
      }),
    ],
    [
      'unprotected ref',
      (_fixture: ReturnType<typeof fixtureRepository>) => ({
        dispatch_ref_protected: 'false',
      }),
    ],
  ])('rejects %s', (_label, change) => {
    const fixture = fixtureRepository();
    expect(() =>
      assertReleaseCandidateAuthority({
        repository_root: fixture.root,
        candidate_sha: fixture.sha,
        protected_ref: 'refs/heads/main',
        dispatch_ref: 'refs/heads/main',
        dispatch_ref_protected: 'true',
        ...change(fixture),
      }),
    ).toThrow();
  });

  it('rejects dirty source, non-RC versions, and package-lock mismatch', () => {
    const dirty = fixtureRepository();
    writeFileSync(join(dirty.root, 'dirty.txt'), 'dirty');
    expect(() =>
      assertReleaseCandidateAuthority({
        repository_root: dirty.root,
        candidate_sha: dirty.sha,
        protected_ref: 'refs/heads/main',
      }),
    ).toThrow('exactly clean');

    const stable = fixtureRepository('2.0.0');
    expect(() =>
      assertReleaseCandidateAuthority({
        repository_root: stable.root,
        candidate_sha: stable.sha,
        protected_ref: 'refs/heads/main',
      }),
    ).toThrow('X.Y.Z-rc.N');

    const mismatch = fixtureRepository();
    const lockPath = join(mismatch.root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages[''].version = '2.0.0-rc.2';
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
    git(mismatch.root, ['add', '.']);
    git(mismatch.root, ['commit', '-m', 'mismatch']);
    const mismatchSha = git(mismatch.root, ['rev-parse', 'HEAD']);
    expect(() =>
      assertReleaseCandidateAuthority({
        repository_root: mismatch.root,
        candidate_sha: mismatchSha,
        protected_ref: 'refs/heads/main',
      }),
    ).toThrow('package-lock.json top-level and root package versions differ');
  });
});

describe('Homebrew release-candidate inputs', () => {
  const rows = [
    ['darwin', 'arm64', 'librarium-macos-arm64', 'a'],
    ['darwin', 'x64', 'librarium-macos-x64', 'b'],
    ['linux', 'arm64', 'librarium-linux-arm64', 'c'],
    ['linux', 'x64', 'librarium-linux-x64', 'd'],
  ].map(([platform, arch, name, digest]) => ({
    platform: platform as 'darwin' | 'linux',
    arch: arch as 'arm64' | 'x64',
    name: name!,
    sha256: `sha256:${digest!.repeat(64)}`,
  }));

  it.each([
    ['darwin', 'arm64', 'librarium-macos-arm64'],
    ['darwin', 'x64', 'librarium-macos-x64'],
    ['linux', 'arm64', 'librarium-linux-arm64'],
    ['linux', 'x64', 'librarium-linux-x64'],
  ] as const)(
    'selects the exact %s/%s formula branch',
    (platform, arch, name) => {
      expect(homebrewInputFor(rows, platform, arch).name).toBe(name);
    },
  );

  it('renders all exact local formula inputs without a tap write', () => {
    const formula = renderLocalHomebrewFormula({
      version: '2.0.0-rc.1',
      rows,
    });
    for (const row of rows) {
      expect(formula).toContain(row.name);
      expect(formula).toContain(row.sha256.slice(7));
    }
    expect(formula).not.toContain('git push');
    expect(formula).not.toContain('brew tap');
  });
});
