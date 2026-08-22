import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalValidationMatrix } from '../src/node-live-validation.js';
import { createFilesystemCandidateAuthority } from '../src/node-live-validation-binding.js';
import {
  assembleReleaseCandidate,
  assertReleaseCandidateVersion,
  assertReleaseMatrixParity,
  buildFrozenReleasePackage,
  freezeReleasePackage,
  RELEASE_CANDIDATE_RECORD_NAMES,
  RELEASE_CANDIDATE_SEA_TARGETS,
  releaseCandidateArtifactArguments,
  releaseCandidateInternals,
  verifyReleaseCandidate,
} from '../src/node-release-candidate.js';

const temporaryRoots: string[] = [];
const VERSION = '2.0.0-rc.1';

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarium-rc-test-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const source = `${value.toString(8).padStart(length - 1, '0')}\0`;
  header.write(source, offset, length, 'ascii');
}

function tarEntry(
  path: string,
  content: Uint8Array,
  mode = 0o644,
  type = '0',
): Buffer {
  const name = `package/${path}`;
  if (Buffer.byteLength(name) > 100)
    throw new Error(`Fixture path too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
  return Buffer.concat([header, Buffer.from(content), padding]);
}

function makeTarball(
  files: Readonly<Record<string, string | Uint8Array>>,
): Buffer {
  const entries = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) =>
      tarEntry(
        path,
        typeof content === 'string' ? Buffer.from(content) : content,
      ),
    );
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1_024)]), {
    level: 9,
  });
}

function matrix(overrides: Record<string, unknown> = {}) {
  const catalogDigest = 'fnv1a64.1:aaaaaaaaaaaaaaaa';
  const pricingFingerprint = `sha256:${'b'.repeat(64)}`;
  const base = {
    schema_version: 1,
    catalog_digest: catalogDigest,
    pricing_snapshot_fingerprint: pricingFingerprint,
    targets: Array.from({ length: 41 }, (_, index) => {
      const id = String(index).padStart(2, '0');
      return {
        key: `provider-${id}/profile`,
        adapter_id: `adapter-${id}`,
        binding_id: `binding-${id}`,
        catalog_digest: catalogDigest,
        requested_identity: {
          provider_id: `provider-${id}`,
          profile_id: 'profile',
        },
        expected_effective_identity: {
          provider_id: `provider-${id}`,
          profile_id: 'profile',
        },
        credential_family: `CREDENTIAL_${id}`,
        pricing_snapshot_fingerprint: pricingFingerprint,
      };
    }),
    ...overrides,
  };
  if (
    Object.hasOwn(overrides, 'catalog_digest') ||
    Object.hasOwn(overrides, 'pricing_snapshot_fingerprint')
  ) {
    base.targets = base.targets.map((target) => ({
      ...target,
      catalog_digest: base.catalog_digest as string,
      pricing_snapshot_fingerprint: base.pricing_snapshot_fingerprint as string,
    }));
  }
  return {
    ...base,
    fingerprint: sha256(releaseCandidateInternals.canonicalJson(base)),
  };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commitRepository(root: string): void {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'RC Fixture']);
  git(root, ['config', 'user.email', 'rc@example.invalid']);
  git(root, ['config', 'commit.gpgSign', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function canonicalWrite(path: string, value: unknown): void {
  writeFileSync(path, releaseCandidateInternals.canonicalText(value));
}

function fixtureRepository(root: string): {
  readonly repository: string;
  readonly tarball: string;
} {
  const repository = join(root, 'repository');
  mkdirSync(repository);
  writeFileSync(join(repository, '.gitignore'), 'dist/\n');
  const packageValue = {
    name: 'librarium',
    version: VERSION,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './core': {
        types: './dist/core-entry.d.ts',
        import: './dist/core.js',
      },
      './node': {
        types: './dist/node-entry.d.ts',
        import: './dist/node.js',
      },
    },
    files: ['dist'],
  };
  const lockValue = {
    name: 'librarium',
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'librarium', version: VERSION },
    },
  };
  const packageJson = `${JSON.stringify(packageValue, null, 2)}\n`;
  const packageLock = `${JSON.stringify(lockValue, null, 2)}\n`;
  writeFileSync(join(repository, 'package.json'), packageJson);
  writeFileSync(join(repository, 'package-lock.json'), packageLock);
  writeFileSync(join(repository, 'LICENSE'), 'fixture license\n');
  writeFileSync(join(repository, 'README.md'), 'fixture readme\n');
  mkdirSync(join(repository, 'dist'));
  writeFileSync(
    join(repository, 'dist/index.js'),
    'export const fixture = true;\n',
  );
  writeFileSync(
    join(repository, 'dist/index.d.ts'),
    'export declare const fixture: true;\n',
  );
  writeFileSync(
    join(repository, 'dist/core-entry.d.ts'),
    'export declare const core: true;\n',
  );
  writeFileSync(
    join(repository, 'dist/node-entry.d.ts'),
    'export declare const node: true;\n',
  );
  writeFileSync(join(repository, 'dist/index.d.ts.map'), '{}\n');
  mkdirSync(join(repository, 'contracts/v1/schema'), { recursive: true });
  writeFileSync(join(repository, 'contracts/v1/manifest.json'), '{}\n');
  writeFileSync(join(repository, 'contracts/v1/checksums.sha256'), 'fixture\n');
  writeFileSync(
    join(repository, 'contracts/v1/schema/interchange.schema.json'),
    '{}\n',
  );
  commitRepository(repository);
  const tarball = join(root, `librarium-${VERSION}.tgz`);
  writeFileSync(
    tarball,
    makeTarball({
      LICENSE: 'fixture license\n',
      'README.md': 'fixture readme\n',
      'dist/index.d.ts': 'export declare const fixture: true;\n',
      'dist/index.d.ts.map': '{}\n',
      'dist/index.js': 'export const fixture = true;\n',
      'dist/core-entry.d.ts': 'export declare const core: true;\n',
      'dist/node-entry.d.ts': 'export declare const node: true;\n',
      'package.json': packageJson,
    }),
  );
  return { repository, tarball };
}

function seaRoot(root: string): string {
  const sea = join(root, 'sea-input');
  mkdirSync(sea);
  for (const target of RELEASE_CANDIDATE_SEA_TARGETS) {
    const path = join(sea, target.name);
    let bytes: Buffer;
    if (target.platform === 'linux') {
      bytes = Buffer.alloc(64);
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
      bytes.writeUInt16LE(target.arch === 'x64' ? 62 : 183, 18);
    } else if (target.platform === 'darwin') {
      bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(0xfeed_facf, 0);
      bytes.writeUInt32LE(target.arch === 'x64' ? 0x0100_0007 : 0x0100_000c, 4);
    } else {
      bytes = Buffer.alloc(128);
      bytes.writeUInt16LE(0x5a4d, 0);
      bytes.writeUInt32LE(0x40, 0x3c);
      bytes.writeUInt32LE(0x0000_4550, 0x40);
      bytes.writeUInt16LE(0x8664, 0x44);
    }
    writeFileSync(path, bytes);
    if (target.platform !== 'win32') chmodSync(path, 0o755);
  }
  return sea;
}

const fixtureDependencies = {
  load_source_matrix: () => matrix(),
  load_installed_matrix: () => matrix(),
};

async function completeFixture() {
  const root = temporaryRoot();
  const { repository, tarball } = fixtureRepository(root);
  const packageRoot = join(root, 'frozen-package');
  const frozen = await freezeReleasePackage({
    repository_root: repository,
    output_root: packageRoot,
    tarball,
    dependencies: fixtureDependencies,
  });
  const sea = seaRoot(root);
  const candidateRoot = join(root, 'candidate');
  const candidate = await assembleReleaseCandidate({
    repository_root: repository,
    package_root: packageRoot,
    sea_root: sea,
    output_root: candidateRoot,
    dependencies: fixtureDependencies,
  });
  return {
    root,
    repository,
    packageRoot,
    sea,
    candidateRoot,
    frozen,
    candidate,
  };
}

function allFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return allFiles(root, path);
    return [relative(root, path).split(sep).join('/')];
  });
}

function refreshChecksums(candidateRoot: string): void {
  const lines = allFiles(candidateRoot)
    .filter((path) => path !== 'SHA256SUMS')
    .sort()
    .map((path) => {
      const bytes = readFileSync(join(candidateRoot, ...path.split('/')));
      return `${sha256(bytes).slice(7)}  ${path}`;
    });
  writeFileSync(join(candidateRoot, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function mutateCanonical(path: string, mutation: (value: any) => void): void {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutation(value);
  canonicalWrite(path, value);
}

function updateRecordReference(
  candidateRoot: string,
  name: (typeof RELEASE_CANDIDATE_RECORD_NAMES)[number],
): void {
  const recordPath = join(candidateRoot, 'records', `${name}.json`);
  const bytes = readFileSync(recordPath);
  mutateCanonical(join(candidateRoot, 'candidate.json'), (manifest) => {
    manifest.live_validation.records[name].sha256 = sha256(bytes);
    manifest.live_validation.records[name].size = bytes.byteLength;
    manifest.live_validation.artifact_hashes[name] = sha256(bytes);
    if (name === 'provenance') {
      manifest.provenance.sha256 = sha256(bytes);
    }
  });
  refreshChecksums(candidateRoot);
}

describe('release candidate artifact contract', () => {
  it('accepts only strict positive RC versions', () => {
    expect(() => assertReleaseCandidateVersion('1.2.3-rc.1')).not.toThrow();
    expect(() => assertReleaseCandidateVersion('0.0.0-rc.20')).not.toThrow();
    for (const invalid of [
      '1.2.3',
      'v1.2.3-rc.1',
      '1.2.3-rc.0',
      '1.2.3-rc.01',
      '01.2.3-rc.1',
      '1.2.3-RC.1',
      '1.2.3-rc.1+build',
    ]) {
      expect(() => assertReleaseCandidateVersion(invalid)).toThrow(
        'X.Y.Z-rc.N',
      );
    }
  });

  it('accepts the real 41-profile matrix and its versioned catalog digest', () => {
    const actual = buildCanonicalValidationMatrix();
    expect(actual.catalog_digest).toMatch(/^fnv1a64\.1:[0-9a-f]{16}$/);
    expect(() => assertReleaseMatrixParity(actual, actual)).not.toThrow();
  });

  it('parses the installed matrix receipt without executing packaged code', async () => {
    const actual = buildCanonicalValidationMatrix();
    const sentinel = join(temporaryRoot(), 'must-not-exist');
    const installed =
      await releaseCandidateInternals.defaultLoadInstalledMatrix(
        '',
        new Map([
          [
            'dist/release-matrix.json',
            Buffer.from(releaseCandidateInternals.canonicalText(actual)),
          ],
          [
            'dist/node.js',
            Buffer.from(
              `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed');`,
            ),
          ],
        ]),
      );
    expect(() => assertReleaseMatrixParity(actual, installed)).not.toThrow();
    expect(lstatSync(sentinel, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('probes a freshly built package matrix under permission isolation when available', async () => {
    if (!existsSync(join(process.cwd(), 'dist/node.js'))) return;
    const trusted = buildCanonicalValidationMatrix();
    const built = await releaseCandidateInternals.defaultLoadBuiltMatrix(
      process.cwd(),
    );
    expect(() => assertReleaseMatrixParity(trusted, built)).not.toThrow();
  });

  it('builds and freezes one package receipt before npm pack without rebuilding it', async () => {
    const root = temporaryRoot();
    const { repository } = fixtureRepository(root);
    const output = join(root, 'package-stage');
    const commands: string[][] = [];
    const frozen = await buildFrozenReleasePackage({
      repository_root: repository,
      output_root: output,
      dependencies: {
        load_source_matrix: () => matrix(),
        load_built_matrix: () => matrix(),
        run: (_executable, args) => {
          commands.push([...args]);
          if (args[0] === 'run') return '';
          const destinationIndex = args.indexOf('--pack-destination');
          const packRoot = args[destinationIndex + 1];
          if (!packRoot) throw new Error('missing pack destination');
          const filename = `librarium-${VERSION}.tgz`;
          const files: Record<string, Uint8Array> = {
            LICENSE: readFileSync(join(repository, 'LICENSE')),
            'README.md': readFileSync(join(repository, 'README.md')),
            'package.json': readFileSync(join(repository, 'package.json')),
          };
          for (const path of allFiles(join(repository, 'dist'))) {
            files[`dist/${path}`] = readFileSync(
              join(repository, 'dist', ...path.split('/')),
            );
          }
          writeFileSync(join(packRoot, filename), makeTarball(files));
          return JSON.stringify([{ filename }]);
        },
      },
    });
    expect(commands.map((args) => args[0])).toEqual(['run', 'pack']);
    expect(frozen.installed_package.target_count).toBe(41);
    expect(frozen.npm.inventory).toContainEqual(
      expect.objectContaining({ path: 'dist/release-matrix.json' }),
    );
    expect(
      lstatSync(join(output, 'npm', `librarium-${VERSION}.tgz`)).isFile(),
    ).toBe(true);
  });

  it('builds one deterministic, transitive candidate and existing authority fingerprint', async () => {
    const fixture = await completeFixture();
    const verified = await verifyReleaseCandidate({
      repository_root: fixture.repository,
      candidate_root: fixture.candidateRoot,
      dependencies: fixtureDependencies,
    });
    expect(verified.candidate).toEqual(fixture.candidate.candidate);
    expect(verified.installed_package.target_count).toBe(41);
    expect(verified.sea.rows).toHaveLength(5);
    expect(verified.live_validation.record_names).toEqual(
      RELEASE_CANDIDATE_RECORD_NAMES,
    );
    expect(
      verified.npm.inventory.some((row) => row.path.startsWith('contracts/v1')),
    ).toBe(false);
    expect(verified.contracts_v1.files).toHaveLength(3);
    const authority = createFilesystemCandidateAuthority({
      repository_root: fixture.repository,
      package_json: join(fixture.repository, 'package.json'),
      artifact_root: fixture.candidateRoot,
      artifacts: Object.fromEntries(
        RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
          name,
          `records/${name}.json`,
        ]),
      ),
    });
    expect(authority.candidate_fingerprint()).toBe(
      verified.candidate.fingerprint,
    );
    expect(() => authority.verify()).not.toThrow();
    writeFileSync(
      join(fixture.candidateRoot, 'sea/librarium-linux-x64'),
      'mutated-after-authority-freeze',
    );
    expect(() => authority.verify()).toThrow(
      'transitive artifact tree drifted',
    );
    expect(releaseCandidateArtifactArguments(verified)).toEqual(
      RELEASE_CANDIDATE_RECORD_NAMES.flatMap((name) => [
        '--artifact',
        `${name}=records/${name}.json`,
      ]),
    );
  });

  it('reassembles byte-identical candidates without rebuilding package bytes', async () => {
    const fixture = await completeFixture();
    const second = join(fixture.root, 'candidate-second');
    await assembleReleaseCandidate({
      repository_root: fixture.repository,
      package_root: fixture.packageRoot,
      sea_root: fixture.sea,
      output_root: second,
      dependencies: fixtureDependencies,
    });
    const firstFiles = allFiles(fixture.candidateRoot).sort();
    expect(allFiles(second).sort()).toEqual(firstFiles);
    for (const path of firstFiles) {
      expect(readFileSync(join(second, ...path.split('/')))).toEqual(
        readFileSync(join(fixture.candidateRoot, ...path.split('/'))),
      );
    }
  });

  it('verifies from a fresh clean checkout without ignored dist output', async () => {
    const fixture = await completeFixture();
    rmSync(join(fixture.repository, 'dist'), { recursive: true });
    await expect(
      verifyReleaseCandidate({
        repository_root: fixture.repository,
        candidate_root: fixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).resolves.toMatchObject({ candidate: { version: VERSION } });
  });

  it('rejects dirty source and refuses duplicate or clobbering output', async () => {
    const fixture = await completeFixture();
    writeFileSync(join(fixture.repository, 'dirty.txt'), 'dirty');
    await expect(
      verifyReleaseCandidate({
        repository_root: fixture.repository,
        candidate_root: fixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('exact clean Git SHA and tree');
    unlinkSync(join(fixture.repository, 'dirty.txt'));
    await expect(
      assembleReleaseCandidate({
        repository_root: fixture.repository,
        package_root: fixture.packageRoot,
        sea_root: fixture.sea,
        output_root: fixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('refusing to clobber');
  });

  it('rejects a packed package.json that differs from the clean source bytes', async () => {
    const root = temporaryRoot();
    const { repository, tarball } = fixtureRepository(root);
    const packageValue = JSON.parse(
      readFileSync(join(repository, 'package.json'), 'utf8'),
    );
    const alteredPackage = `${JSON.stringify(
      { ...packageValue, scripts: { preinstall: 'node injected.js' } },
      null,
      2,
    )}\n`;
    writeFileSync(
      tarball,
      makeTarball({
        LICENSE: readFileSync(join(repository, 'LICENSE')),
        'README.md': readFileSync(join(repository, 'README.md')),
        'dist/index.d.ts': readFileSync(join(repository, 'dist/index.d.ts')),
        'dist/index.d.ts.map': readFileSync(
          join(repository, 'dist/index.d.ts.map'),
        ),
        'dist/index.js': readFileSync(join(repository, 'dist/index.js')),
        'dist/core-entry.d.ts': readFileSync(
          join(repository, 'dist/core-entry.d.ts'),
        ),
        'dist/node-entry.d.ts': readFileSync(
          join(repository, 'dist/node-entry.d.ts'),
        ),
        'package.json': alteredPackage,
      }),
    );
    await expect(
      freezeReleasePackage({
        repository_root: repository,
        output_root: join(root, 'tampered-package'),
        tarball,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('built source: package.json');
  });

  it('rejects a symlinked output parent that resolves inside the repository', async () => {
    const fixture = await completeFixture();
    const alias = join(fixture.root, 'repository-alias');
    symlinkSync(fixture.repository, alias, 'dir');
    await expect(
      assembleReleaseCandidate({
        repository_root: fixture.repository,
        package_root: fixture.packageRoot,
        sea_root: fixture.sea,
        output_root: join(alias, 'candidate-output'),
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('symlink path component');
  });

  it('keeps assembled output outside frozen package and SEA input roots', async () => {
    const fixture = await completeFixture();
    await expect(
      assembleReleaseCandidate({
        repository_root: fixture.repository,
        package_root: fixture.packageRoot,
        sea_root: fixture.sea,
        output_root: join(fixture.packageRoot, 'nested-candidate'),
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('outside immutable artifact inputs');
    await expect(
      assembleReleaseCandidate({
        repository_root: fixture.repository,
        package_root: fixture.packageRoot,
        sea_root: fixture.sea,
        output_root: join(fixture.sea, 'nested-candidate'),
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('outside immutable artifact inputs');
  });

  it('rejects transitive mutation before live authority construction', async () => {
    const fixture = await completeFixture();
    writeFileSync(
      join(fixture.candidateRoot, 'sea/librarium-linux-x64'),
      'mutated-before-authority',
    );
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: fixture.repository,
        package_json: join(fixture.repository, 'package.json'),
        artifact_root: fixture.candidateRoot,
        artifacts: Object.fromEntries(
          RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
            name,
            `records/${name}.json`,
          ]),
        ),
      }),
    ).toThrow('SHA256SUMS drifted');
  });

  it.each([
    [
      'package lock',
      (root: string) =>
        writeFileSync(join(root, 'source/package-lock.json'), 'mutated'),
    ],
    [
      'contract',
      (root: string) =>
        writeFileSync(
          join(root, 'contracts/v1/schema/interchange.schema.json'),
          'mutated',
        ),
    ],
    [
      'extra file',
      (root: string) => writeFileSync(join(root, 'extra.bin'), 'mutated'),
    ],
  ])(
    'rejects pre-authority %s mutation across the complete RC tree',
    async (_label, mutate) => {
      const fixture = await completeFixture();
      mutate(fixture.candidateRoot);
      expect(() =>
        createFilesystemCandidateAuthority({
          repository_root: fixture.repository,
          package_json: join(fixture.repository, 'package.json'),
          artifact_root: fixture.candidateRoot,
          artifacts: Object.fromEntries(
            RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
              name,
              `records/${name}.json`,
            ]),
          ),
        }),
      ).toThrow();
    },
  );

  it('fails closed on missing candidate manifest or a noncanonical RC record map', async () => {
    const missing = await completeFixture();
    unlinkSync(join(missing.candidateRoot, 'candidate.json'));
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: missing.repository,
        package_json: join(missing.repository, 'package.json'),
        artifact_root: missing.candidateRoot,
        artifacts: Object.fromEntries(
          RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
            name,
            `records/${name}.json`,
          ]),
        ),
      }),
    ).toThrow('requires candidate.json');

    const wrongMap = await completeFixture();
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: wrongMap.repository,
        package_json: join(wrongMap.repository, 'package.json'),
        artifact_root: wrongMap.candidateRoot,
        artifacts: {
          declarations: 'records/declarations.json',
        },
      }),
    ).toThrow('exact five record paths');
  });

  it.each([
    [
      'missing',
      (root: string) => unlinkSync(join(root, 'sea/librarium-linux-x64')),
    ],
    [
      'extra',
      (root: string) => writeFileSync(join(root, 'extra.bin'), 'unexpected'),
    ],
    [
      'unsafe name',
      (root: string) => writeFileSync(join(root, 'unsafe name'), 'unexpected'),
    ],
  ])('rejects %s artifacts', async (_label, mutate) => {
    const fixture = await completeFixture();
    mutate(fixture.candidateRoot);
    await expect(
      verifyReleaseCandidate({
        repository_root: fixture.repository,
        candidate_root: fixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow();
  });

  it('rejects symlink and special artifacts before trusting checksums', async () => {
    const symlinkFixture = await completeFixture();
    symlinkSync(
      join(symlinkFixture.candidateRoot, 'source/package.json'),
      join(symlinkFixture.candidateRoot, 'linked-package.json'),
    );
    await expect(
      verifyReleaseCandidate({
        repository_root: symlinkFixture.repository,
        candidate_root: symlinkFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('symlink or special file');

    if (process.platform !== 'win32') {
      const specialFixture = await completeFixture();
      execFileSync('mkfifo', [
        join(specialFixture.candidateRoot, 'named-pipe'),
      ]);
      await expect(
        verifyReleaseCandidate({
          repository_root: specialFixture.repository,
          candidate_root: specialFixture.candidateRoot,
          dependencies: fixtureDependencies,
        }),
      ).rejects.toThrow('symlink or special file');
    }
  });

  it('rejects checksum drift, unsorted checksums, and duplicate inventory rows', async () => {
    const checksumFixture = await completeFixture();
    const checksumPath = join(checksumFixture.candidateRoot, 'SHA256SUMS');
    const lines = readFileSync(checksumPath, 'utf8').trimEnd().split('\n');
    writeFileSync(checksumPath, `${lines.reverse().join('\n')}\n`);
    await expect(
      verifyReleaseCandidate({
        repository_root: checksumFixture.repository,
        candidate_root: checksumFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('must be sorted');

    const duplicateFixture = await completeFixture();
    mutateCanonical(
      join(duplicateFixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        manifest.npm.inventory.push(manifest.npm.inventory[0]);
      },
    );
    refreshChecksums(duplicateFixture.candidateRoot);
    await expect(
      verifyReleaseCandidate({
        repository_root: duplicateFixture.repository,
        candidate_root: duplicateFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('unique sorted paths');
  });

  it('rejects duplicate and explicit directory entries inside the npm tarball', () => {
    const duplicate = gzipSync(
      Buffer.concat([
        tarEntry('package.json', Buffer.from('{}\n')),
        tarEntry('package.json', Buffer.from('{}\n')),
        Buffer.alloc(1_024),
      ]),
    );
    expect(() => releaseCandidateInternals.parseNpmTarball(duplicate)).toThrow(
      'unique sorted paths',
    );
    const directory = gzipSync(
      Buffer.concat([
        tarEntry('dist', Buffer.alloc(0), 0o755, '5'),
        Buffer.alloc(1_024),
      ]),
    );
    expect(() => releaseCandidateInternals.parseNpmTarball(directory)).toThrow(
      'extra directory entry',
    );
  });

  it('requires every public package declaration entrypoint', () => {
    const packageJson = `${JSON.stringify({
      name: 'librarium',
      version: VERSION,
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './node': {
          types: './dist/node-entry.d.ts',
          import: './dist/node.js',
        },
      },
    })}\n`;
    const rows = releaseCandidateInternals.parseNpmTarball(
      makeTarball({
        LICENSE: 'license',
        'README.md': 'readme',
        'dist/index.d.ts': 'export {};',
        'dist/index.js': 'export {};',
        'dist/node.js': 'export {};',
        'package.json': packageJson,
      }),
    );
    expect(() =>
      releaseCandidateInternals.assertPackagedInventoryShape(rows),
    ).toThrow('missing public declaration entrypoint dist/node-entry.d.ts');
  });

  it('rejects wrong SEA formats', async () => {
    const formatFixture = await completeFixture();
    const linuxPath = join(
      formatFixture.candidateRoot,
      'sea/librarium-linux-x64',
    );
    writeFileSync(linuxPath, 'not-elf');
    mutateCanonical(
      join(formatFixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        const row = manifest.sea.rows.find(
          (candidate: any) => candidate.name === 'librarium-linux-x64',
        );
        const bytes = readFileSync(linuxPath);
        row.sha256 = sha256(bytes);
        row.size = bytes.byteLength;
      },
    );
    refreshChecksums(formatFixture.candidateRoot);
    await expect(
      verifyReleaseCandidate({
        repository_root: formatFixture.repository,
        candidate_root: formatFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('expected 64-bit ELF binary');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects missing Unix executable mode',
    async () => {
      const modeFixture = await completeFixture();
      chmodSync(
        join(modeFixture.candidateRoot, 'sea/librarium-linux-x64'),
        0o644,
      );
      await expect(
        verifyReleaseCandidate({
          repository_root: modeFixture.repository,
          candidate_root: modeFixture.candidateRoot,
          dependencies: fixtureDependencies,
        }),
      ).rejects.toThrow('executable mode');
    },
  );

  it('rejects self-consistent contract replacement against the exact Git source', async () => {
    const fixture = await completeFixture();
    const contractPath = join(
      fixture.candidateRoot,
      'contracts/v1/schema/interchange.schema.json',
    );
    writeFileSync(contractPath, '{"mutated":true}\n');
    mutateCanonical(
      join(fixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        const row = manifest.contracts_v1.files.find(
          (candidate: any) =>
            candidate.path === 'contracts/v1/schema/interchange.schema.json',
        );
        const bytes = readFileSync(contractPath);
        row.sha256 = sha256(bytes);
        row.size = bytes.byteLength;
        manifest.contracts_v1.fingerprint = sha256(
          releaseCandidateInternals.canonicalJson(manifest.contracts_v1.files),
        );
      },
    );
    refreshChecksums(fixture.candidateRoot);
    await expect(
      verifyReleaseCandidate({
        repository_root: fixture.repository,
        candidate_root: fixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('exact Git source');
  });

  it('keeps approved records cross-linked to self-consistent source and contract mutations', async () => {
    const lockFixture = await completeFixture();
    const lockPath = join(
      lockFixture.candidateRoot,
      'source/package-lock.json',
    );
    writeFileSync(lockPath, '{"changed":true}\n');
    mutateCanonical(
      join(lockFixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        const bytes = readFileSync(lockPath);
        manifest.source_metadata.package_lock.sha256 = sha256(bytes);
        manifest.source_metadata.package_lock.size = bytes.byteLength;
      },
    );
    refreshChecksums(lockFixture.candidateRoot);
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: lockFixture.repository,
        package_json: join(lockFixture.repository, 'package.json'),
        artifact_root: lockFixture.candidateRoot,
        artifacts: Object.fromEntries(
          RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
            name,
            `records/${name}.json`,
          ]),
        ),
      }),
    ).toThrow('exact clean source');

    const contractFixture = await completeFixture();
    const contractPath = join(
      contractFixture.candidateRoot,
      'contracts/v1/schema/interchange.schema.json',
    );
    writeFileSync(contractPath, '{"changed":true}\n');
    mutateCanonical(
      join(contractFixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        const row = manifest.contracts_v1.files.find(
          (candidate: any) =>
            candidate.path === 'contracts/v1/schema/interchange.schema.json',
        );
        const bytes = readFileSync(contractPath);
        row.sha256 = sha256(bytes);
        row.size = bytes.byteLength;
        manifest.contracts_v1.fingerprint = sha256(
          releaseCandidateInternals.canonicalJson(manifest.contracts_v1.files),
        );
      },
    );
    refreshChecksums(contractFixture.candidateRoot);
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: contractFixture.repository,
        package_json: join(contractFixture.repository, 'package.json'),
        artifact_root: contractFixture.candidateRoot,
        artifacts: Object.fromEntries(
          RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
            name,
            `records/${name}.json`,
          ]),
        ),
      }),
    ).toThrow('exact clean source');
  });

  it('binds candidate identity and installed matrix to the approved record set', async () => {
    const matrixFixture = await completeFixture();
    mutateCanonical(
      join(matrixFixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        manifest.installed_package.targets[0].adapter_id = 'forged-adapter';
        manifest.installed_package.matrix_fingerprint = sha256(
          releaseCandidateInternals.canonicalJson({
            schema_version: 1,
            catalog_digest: manifest.installed_package.catalog_digest,
            pricing_snapshot_fingerprint:
              manifest.installed_package.pricing_snapshot_fingerprint,
            targets: manifest.installed_package.targets,
          }),
        );
      },
    );
    refreshChecksums(matrixFixture.candidateRoot);
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: matrixFixture.repository,
        package_json: join(matrixFixture.repository, 'package.json'),
        artifact_root: matrixFixture.candidateRoot,
        artifacts: Object.fromEntries(
          RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
            name,
            `records/${name}.json`,
          ]),
        ),
      }),
    ).toThrow('package_inventory record is invalid');

    const identityFixture = await completeFixture();
    mutateCanonical(
      join(identityFixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        manifest.candidate.git_sha = 'd'.repeat(40);
      },
    );
    refreshChecksums(identityFixture.candidateRoot);
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: identityFixture.repository,
        package_json: join(identityFixture.repository, 'package.json'),
        artifact_root: identityFixture.candidateRoot,
        artifacts: Object.fromEntries(
          RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
            name,
            `records/${name}.json`,
          ]),
        ),
      }),
    ).toThrow('exact clean source');
  });

  it('rejects manifest-controlled relocation of canonical artifact paths', async () => {
    const fixture = await completeFixture();
    mkdirSync(join(fixture.candidateRoot, 'alternate'));
    renameSync(
      join(fixture.candidateRoot, 'source/package.json'),
      join(fixture.candidateRoot, 'alternate/package.json'),
    );
    mutateCanonical(
      join(fixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        manifest.source_metadata.package_json.path = 'alternate/package.json';
      },
    );
    refreshChecksums(fixture.candidateRoot);
    await expect(
      verifyReleaseCandidate({
        repository_root: fixture.repository,
        candidate_root: fixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('noncanonical artifact path');
  });

  it.each([
    [
      'matrix',
      (manifest: any) => {
        manifest.installed_package.targets[0].adapter_id = 'drifted-adapter';
      },
    ],
    [
      'catalog',
      (manifest: any) => {
        manifest.installed_package.catalog_digest = `sha256:${'d'.repeat(64)}`;
      },
    ],
    [
      'pricing',
      (manifest: any) => {
        manifest.installed_package.pricing_snapshot_fingerprint = `sha256:${'d'.repeat(64)}`;
      },
    ],
    [
      'contracts fingerprint',
      (manifest: any) => {
        manifest.contracts_v1.fingerprint = `sha256:${'d'.repeat(64)}`;
      },
    ],
    [
      'declaration inventory',
      (manifest: any) => {
        manifest.npm.declarations[0].sha256 = `sha256:${'d'.repeat(64)}`;
      },
    ],
  ])(
    'rejects %s drift with repaired outer checksums',
    async (_label, mutate) => {
      const fixture = await completeFixture();
      mutateCanonical(join(fixture.candidateRoot, 'candidate.json'), mutate);
      refreshChecksums(fixture.candidateRoot);
      await expect(
        verifyReleaseCandidate({
          repository_root: fixture.repository,
          candidate_root: fixture.candidateRoot,
          dependencies: fixtureDependencies,
        }),
      ).rejects.toThrow();
    },
  );

  it('rejects transitive package-record and attestation-subject drift', async () => {
    const inventoryFixture = await completeFixture();
    mutateCanonical(
      join(inventoryFixture.candidateRoot, 'records/package_inventory.json'),
      (record) => {
        record.files[0].sha256 = `sha256:${'d'.repeat(64)}`;
      },
    );
    updateRecordReference(inventoryFixture.candidateRoot, 'package_inventory');
    await expect(
      verifyReleaseCandidate({
        repository_root: inventoryFixture.repository,
        candidate_root: inventoryFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('drifted from its referenced bytes');

    const subjectFixture = await completeFixture();
    mutateCanonical(
      join(subjectFixture.candidateRoot, 'records/provenance.json'),
      (record) => {
        record.subject[0].digest.sha256 = 'd'.repeat(64);
      },
    );
    updateRecordReference(subjectFixture.candidateRoot, 'provenance');
    await expect(
      verifyReleaseCandidate({
        repository_root: subjectFixture.repository,
        candidate_root: subjectFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('attestation subject set drifted');
  });

  it('rejects a missing live record and SEA row drift', async () => {
    const recordFixture = await completeFixture();
    unlinkSync(join(recordFixture.candidateRoot, 'records/declarations.json'));
    await expect(
      verifyReleaseCandidate({
        repository_root: recordFixture.repository,
        candidate_root: recordFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow();

    const seaFixture = await completeFixture();
    mutateCanonical(
      join(seaFixture.candidateRoot, 'candidate.json'),
      (manifest) => {
        manifest.sea.rows[0].arch = 'x64';
      },
    );
    refreshChecksums(seaFixture.candidateRoot);
    await expect(
      verifyReleaseCandidate({
        repository_root: seaFixture.repository,
        candidate_root: seaFixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('exact five rows');
  });

  it('rejects source-versus-installed package matrix mismatch', () => {
    const installed = matrix({
      pricing_snapshot_fingerprint: `sha256:${'d'.repeat(64)}`,
    });
    expect(() => assertReleaseMatrixParity(matrix(), installed)).toThrow(
      'Source and installed-package canonical matrices differ',
    );
  });

  it('rejects a mutated npm tarball even when a sibling copy remains valid', async () => {
    const fixture = await completeFixture();
    const tarballPath = join(
      fixture.candidateRoot,
      ...fixture.candidate.npm.tarball.path.split('/'),
    );
    const backup = join(fixture.root, 'valid-copy.tgz');
    copyFileSync(tarballPath, backup);
    writeFileSync(
      tarballPath,
      Buffer.concat([readFileSync(tarballPath), Buffer.from('x')]),
    );
    await expect(
      verifyReleaseCandidate({
        repository_root: fixture.repository,
        candidate_root: fixture.candidateRoot,
        dependencies: fixtureDependencies,
      }),
    ).rejects.toThrow('SHA256SUMS drifted');
    expect(lstatSync(backup).isFile()).toBe(true);
  });
});
