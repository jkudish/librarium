import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildCanonicalValidationMatrix } from './node-live-validation.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RC_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TAR_BYTES = 256 * 1024 * 1024;
const CANDIDATE_MANIFEST = 'candidate.json';
const CHECKSUM_INDEX = 'SHA256SUMS';
const FROZEN_PACKAGE_MANIFEST = 'frozen-package.json';

export const RELEASE_CANDIDATE_RECORD_NAMES = [
  'declarations',
  'npm_tarball',
  'package_inventory',
  'provenance',
  'sea_manifest',
] as const;

export const RELEASE_CANDIDATE_SEA_TARGETS = [
  {
    platform: 'darwin',
    arch: 'arm64',
    name: 'librarium-macos-arm64',
  },
  { platform: 'darwin', arch: 'x64', name: 'librarium-macos-x64' },
  { platform: 'linux', arch: 'arm64', name: 'librarium-linux-arm64' },
  { platform: 'linux', arch: 'x64', name: 'librarium-linux-x64' },
  {
    platform: 'win32',
    arch: 'x64',
    name: 'librarium-windows-x64.exe',
  },
] as const;

export class ReleaseCandidateContractError extends Error {}

export interface ReleaseGitIdentity {
  readonly sha: string;
  readonly tree: string;
  readonly clean: boolean;
}

export interface ReleaseMatrixTarget {
  readonly key: string;
  readonly adapter_id: string;
  readonly binding_id: string;
  readonly catalog_digest: string;
  readonly requested_identity: unknown;
  readonly expected_effective_identity: unknown;
  readonly credential_family: string;
  readonly pricing_snapshot_fingerprint: string;
}

export interface ReleaseMatrixIdentity {
  readonly target_count: 42;
  readonly catalog_digest: string;
  readonly pricing_snapshot_fingerprint: string;
  readonly matrix_fingerprint: string;
  readonly targets: readonly ReleaseMatrixTarget[];
}

export interface ReleaseCandidateDependencies {
  readonly read_git?: (repositoryRoot: string) => ReleaseGitIdentity;
  readonly load_source_matrix?: (
    repositoryRoot: string,
  ) => Promise<unknown> | unknown;
  /** Authorized package-phase probe of freshly built dist/node.js. */
  readonly load_built_matrix?: (
    repositoryRoot: string,
  ) => Promise<unknown> | unknown;
  readonly load_installed_matrix?: (
    repositoryRoot: string,
    packageFiles: ReadonlyMap<string, Uint8Array>,
  ) => Promise<unknown> | unknown;
  readonly run?: (
    executable: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly capture?: boolean },
  ) => string;
}

interface FileRow {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface PackageFileRow extends FileRow {
  readonly mode: number;
}

interface ArtifactReference {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface FrozenPackageManifest {
  readonly schema_version: 1;
  readonly contract: 'librarium-frozen-package';
  readonly candidate: {
    readonly name: string;
    readonly version: string;
    readonly git_sha: string;
    readonly git_tree: string;
  };
  readonly source_metadata: {
    readonly package_json: ArtifactReference;
    readonly package_lock: ArtifactReference & {
      readonly lockfile_version: number;
    };
  };
  readonly npm: {
    readonly tarball: ArtifactReference;
    readonly inventory: readonly PackageFileRow[];
    readonly declarations: readonly PackageFileRow[];
  };
  readonly contracts_v1: {
    readonly fingerprint: string;
    readonly files: readonly FileRow[];
  };
  readonly installed_package: ReleaseMatrixIdentity;
}

interface CandidateManifest
  extends Omit<FrozenPackageManifest, 'candidate' | 'contract'> {
  readonly contract: 'librarium-release-candidate';
  readonly candidate: FrozenPackageManifest['candidate'] & {
    readonly fingerprint: string;
  };
  readonly sea: {
    readonly rows: readonly (ArtifactReference & {
      readonly platform: string;
      readonly arch: string;
      readonly name: string;
    })[];
  };
  readonly provenance: {
    readonly path: string;
    readonly sha256: string;
    readonly subject_count: 6;
  };
  readonly live_validation: {
    readonly record_names: readonly string[];
    readonly records: Readonly<Record<string, ArtifactReference>>;
    readonly artifact_hashes: Readonly<Record<string, string>>;
  };
  readonly checksum_index: {
    readonly path: 'SHA256SUMS';
    readonly algorithm: 'sha256';
  };
}

interface TarFile extends PackageFileRow {
  readonly content: Uint8Array;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ReleaseCandidateContractError(
      'Release candidate contains a non-JSON value.',
    );
  }
  return encoded;
}

function canonicalText(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function sha256Bytes(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message: string): never {
  throw new ReleaseCandidateContractError(message);
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail(`${label} has missing or extra fields.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 1_024): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum
  ) {
    fail(`${label} must be a bounded nonempty string.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a nonnegative safe integer.`);
  }
  return value as number;
}

function sha256(value: unknown, label: string): string {
  const text = boundedString(value, label, 71);
  if (!SHA256_PATTERN.test(text)) fail(`${label} must be a SHA-256 digest.`);
  return text;
}

function catalogDigest(value: unknown, label: string): string {
  const text = boundedString(value, label, 26);
  if (!/^fnv1a64\.1:[0-9a-f]{16}$/.test(text)) {
    fail(`${label} must be a versioned catalog fingerprint.`);
  }
  return text;
}

export function assertReleaseCandidateVersion(version: string): void {
  if (!RC_VERSION_PATTERN.test(version)) {
    fail(
      'Release candidate version must be X.Y.Z-rc.N with positive N and no leading zero.',
    );
  }
}

function normalizeRelativePath(value: string, label: string): string {
  if (
    !value ||
    value.length > 1_024 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    fail(`${label} contains an unsafe path.`);
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !SAFE_SEGMENT_PATTERN.test(segment),
    )
  ) {
    fail(`${label} contains an unsafe path.`);
  }
  return segments.join('/');
}

function filesystemRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return normalizeRelativePath(value, 'Artifact name');
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function safeExistingDirectory(path: string, label: string): string {
  const lexical = resolve(path);
  const root = parse(lexical).root;
  let current = root;
  for (const component of relative(root, lexical).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const componentStat = lstatSync(current, { throwIfNoEntry: false });
    if (
      !componentStat ||
      (componentStat.isSymbolicLink() && current !== '/var')
    ) {
      fail(`${label} contains a missing or symlink path component.`);
    }
  }
  const stat = lstatSync(lexical, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be an existing non-symlink directory.`);
  }
  return realpathSync(lexical);
}

function assertOutputAvailable(
  path: string,
  repositoryRoot?: string,
  immutableInputRoots: readonly string[] = [],
): string {
  const lexicalOutput = resolve(path);
  if (lstatSync(lexicalOutput, { throwIfNoEntry: false })) {
    fail('Release output already exists; refusing to clobber it.');
  }
  if (!SAFE_SEGMENT_PATTERN.test(basename(lexicalOutput))) {
    fail('Release output directory has an unsafe name.');
  }
  const parent = safeExistingDirectory(
    dirname(lexicalOutput),
    'Release output parent',
  );
  const output = resolve(parent, basename(lexicalOutput));
  if (repositoryRoot && contained(repositoryRoot, output)) {
    fail('Release output must be outside the candidate repository.');
  }
  if (immutableInputRoots.some((root) => contained(root, output))) {
    fail('Release output must be outside immutable artifact inputs.');
  }
  return output;
}

function writeExclusive(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
}

function copyExclusive(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('Release input must be a regular non-symlink file.');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
}

function readBoundedFile(path: string, maximum = MAX_JSON_BYTES): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum) {
    fail('Release artifact must be a bounded regular non-symlink file.');
  }
  return readFileSync(path);
}

function readCanonicalJson(path: string, label: string): unknown {
  const source = readBoundedFile(path).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail(`${label} must contain valid JSON.`);
  }
  if (canonicalText(parsed) !== source) {
    fail(`${label} is not canonical JSON.`);
  }
  return parsed;
}

function listRegularFiles(root: string): FileRow[] {
  const canonicalRoot = safeExistingDirectory(root, 'Artifact root');
  const rows: FileRow[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    )) {
      if (!SAFE_SEGMENT_PATTERN.test(entry.name)) {
        fail('Release artifact inventory contains an unsafe name.');
      }
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        fail('Release artifact inventory contains a symlink or special file.');
      }
      if (stat.isDirectory()) visit(path);
      else {
        if (stat.size > MAX_TAR_BYTES) {
          fail('Release artifact inventory contains an oversized file.');
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_TAR_BYTES * 8) {
          fail('Release artifact inventory is too large.');
        }
        const bytes = readFileSync(path);
        rows.push({
          path: filesystemRelativePath(canonicalRoot, path),
          sha256: sha256Bytes(bytes),
          size: bytes.byteLength,
        });
      }
    }
  };
  visit(canonicalRoot);
  return rows.sort((left, right) => compareText(left.path, right.path));
}

function assertUniqueSortedPaths(
  rows: readonly { readonly path: string }[],
  label: string,
): void {
  const paths = rows.map((row) => normalizeRelativePath(row.path, label));
  const sorted = [...paths].sort(compareText);
  if (
    new Set(paths).size !== paths.length ||
    canonicalJson(paths) !== canonicalJson(sorted)
  ) {
    fail(`${label} must use unique sorted paths.`);
  }
}

function fileRow(value: unknown, label: string): FileRow {
  const row = jsonRecord(value, label);
  exactKeys(row, ['path', 'sha256', 'size'], label);
  return {
    path: normalizeRelativePath(
      boundedString(row.path, `${label}.path`),
      label,
    ),
    sha256: sha256(row.sha256, `${label}.sha256`),
    size: safeInteger(row.size, `${label}.size`),
  };
}

function packageFileRow(value: unknown, label: string): PackageFileRow {
  const row = jsonRecord(value, label);
  exactKeys(row, ['mode', 'path', 'sha256', 'size'], label);
  const mode = safeInteger(row.mode, `${label}.mode`);
  if (mode > 0o7777) fail(`${label}.mode is invalid.`);
  return {
    path: normalizeRelativePath(
      boundedString(row.path, `${label}.path`),
      label,
    ),
    sha256: sha256(row.sha256, `${label}.sha256`),
    size: safeInteger(row.size, `${label}.size`),
    mode,
  };
}

function artifactReference(value: unknown, label: string): ArtifactReference {
  return fileRow(value, label);
}

function artifactReferenceFields(
  value: Record<string, unknown>,
  label: string,
): ArtifactReference {
  return {
    path: normalizeRelativePath(
      boundedString(value.path, `${label}.path`),
      label,
    ),
    sha256: sha256(value.sha256, `${label}.sha256`),
    size: safeInteger(value.size, `${label}.size`),
  };
}

function parseTarNumber(bytes: Uint8Array, label: string): number {
  const source = Buffer.from(bytes)
    .toString('ascii')
    .replaceAll('\0', '')
    .trim();
  if (!source || !/^[0-7]+$/.test(source)) fail(`Tar ${label} is invalid.`);
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value) || value < 0)
    fail(`Tar ${label} is invalid.`);
  return value;
}

function parseTarText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString('utf8');
}

function parsePax(content: Uint8Array): Record<string, string> {
  const source = Buffer.from(content).toString('utf8');
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < source.length) {
    const space = source.indexOf(' ', offset);
    if (space < 1) fail('Tar PAX record is invalid.');
    const lengthText = source.slice(offset, space);
    if (!/^[1-9]\d*$/.test(lengthText)) fail('Tar PAX length is invalid.');
    const length = Number(lengthText);
    const record = source.slice(space + 1, offset + length);
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      !record.endsWith('\n')
    ) {
      fail('Tar PAX record is invalid.');
    }
    const equals = record.indexOf('=');
    if (equals < 1) fail('Tar PAX record is invalid.');
    const key = record.slice(0, equals);
    if (Object.hasOwn(result, key)) fail('Tar PAX record has duplicate keys.');
    result[key] = record.slice(equals + 1, -1);
    offset += length;
  }
  if (offset !== source.length) fail('Tar PAX record is truncated.');
  return result;
}

function parseNpmTarball(bytes: Uint8Array): TarFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    fail('npm tarball is not a bounded valid gzip stream.');
  }
  const rows: TarFile[] = [];
  let offset = 0;
  let pendingPax: Record<string, string> | undefined;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks > 0) fail('Tar archive has data after a zero block.');
    const expectedChecksum = parseTarNumber(
      header.subarray(148, 156),
      'header checksum',
    );
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index]!;
    }
    if (expectedChecksum !== actualChecksum)
      fail('Tar header checksum drifted.');
    const size = parseTarNumber(header.subarray(124, 136), 'entry size');
    if (size > MAX_TAR_BYTES || offset + size > tar.byteLength) {
      fail('Tar entry is truncated or too large.');
    }
    const content = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === 'x') {
      if (pendingPax) fail('Tar archive has stacked PAX headers.');
      pendingPax = parsePax(content);
      continue;
    }
    const prefix = parseTarText(header.subarray(345, 500));
    const headerName = parseTarText(header.subarray(0, 100));
    const archivePath =
      pendingPax?.path ?? [prefix, headerName].filter(Boolean).join('/');
    if (pendingPax?.size !== undefined && Number(pendingPax.size) !== size) {
      fail('Tar PAX size differs from its header.');
    }
    pendingPax = undefined;
    if (!archivePath.startsWith('package/')) {
      fail('npm tarball contains a path outside package/.');
    }
    const path = normalizeRelativePath(
      archivePath.slice('package/'.length),
      'npm tarball entry',
    );
    if (type === '5') fail('npm tarball contains an extra directory entry.');
    if (type !== '0' && type !== '\0') {
      fail('npm tarball contains a link or special entry.');
    }
    const mode = parseTarNumber(header.subarray(100, 108), 'entry mode');
    rows.push({
      path,
      sha256: sha256Bytes(content),
      size,
      mode,
      content: Buffer.from(content),
    });
  }
  if (
    pendingPax ||
    zeroBlocks < 2 ||
    tar.subarray(offset).some((byte) => byte !== 0)
  ) {
    fail('Tar archive termination is invalid.');
  }
  rows.sort((left, right) => compareText(left.path, right.path));
  assertUniqueSortedPaths(rows, 'npm tarball inventory');
  return rows;
}

function publicPackageRows(rows: readonly TarFile[]): PackageFileRow[] {
  return rows.map(({ path, sha256: hash, size, mode }) => ({
    path,
    sha256: hash,
    size,
    mode,
  }));
}

function packageContents(
  rows: readonly TarFile[],
): ReadonlyMap<string, Uint8Array> {
  return new Map(rows.map((row) => [row.path, row.content]));
}

function readGit(repositoryRoot: string): ReleaseGitIdentity {
  const run = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  return {
    sha: run(['rev-parse', 'HEAD']),
    tree: run(['rev-parse', 'HEAD^{tree}']),
    clean: run(['status', '--porcelain', '--untracked-files=all']) === '',
  };
}

function packageMetadata(repositoryRoot: string): {
  readonly name: string;
  readonly version: string;
  readonly packageJson: Buffer;
  readonly packageLock: Buffer;
  readonly lockfileVersion: number;
} {
  const packageJson = readBoundedFile(join(repositoryRoot, 'package.json'));
  const packageLock = readBoundedFile(
    join(repositoryRoot, 'package-lock.json'),
  );
  let packageValue: Record<string, unknown>;
  let lockValue: Record<string, unknown>;
  try {
    packageValue = jsonRecord(
      JSON.parse(packageJson.toString('utf8')),
      'package.json',
    );
    lockValue = jsonRecord(
      JSON.parse(packageLock.toString('utf8')),
      'package-lock.json',
    );
  } catch (error) {
    if (error instanceof ReleaseCandidateContractError) throw error;
    fail('Package metadata must contain valid JSON.');
  }
  const name = boundedString(packageValue.name, 'package.json name', 214);
  const version = boundedString(
    packageValue.version,
    'package.json version',
    128,
  );
  assertReleaseCandidateVersion(version);
  const lockPackages = jsonRecord(
    lockValue.packages,
    'package-lock.json packages',
  );
  const lockRoot = jsonRecord(
    lockPackages[''],
    'package-lock.json root package',
  );
  if (
    lockValue.name !== name ||
    lockValue.version !== version ||
    lockRoot.name !== name ||
    lockRoot.version !== version
  ) {
    fail('package.json and package-lock.json release metadata differ.');
  }
  const lockfileVersion = safeInteger(
    lockValue.lockfileVersion,
    'package-lock.json lockfileVersion',
  );
  return { name, version, packageJson, packageLock, lockfileVersion };
}

function assertGitIdentity(identity: ReleaseGitIdentity): void {
  if (
    !/^[0-9a-f]{40}$/.test(identity.sha) ||
    !/^[0-9a-f]{40}$/.test(identity.tree) ||
    !identity.clean
  ) {
    fail('Release candidate requires an exact clean Git SHA and tree.');
  }
}

function matrixIdentity(value: unknown): ReleaseMatrixIdentity {
  const matrix = jsonRecord(value, 'Canonical installed-package matrix');
  exactKeys(
    matrix,
    [
      'catalog_digest',
      'fingerprint',
      'pricing_snapshot_fingerprint',
      'schema_version',
      'targets',
    ],
    'Canonical installed-package matrix',
  );
  if (matrix.schema_version !== 1) {
    fail('Canonical installed-package matrix schema is unsupported.');
  }
  const targetsValue = matrix.targets;
  if (!Array.isArray(targetsValue))
    fail('Canonical matrix targets must be an array.');
  const targets = targetsValue.map((targetValue, index) => {
    const target = jsonRecord(targetValue, `Canonical matrix target ${index}`);
    exactKeys(
      target,
      [
        'adapter_id',
        'binding_id',
        'catalog_digest',
        'credential_family',
        'expected_effective_identity',
        'key',
        'pricing_snapshot_fingerprint',
        'requested_identity',
      ],
      `Canonical matrix target ${index}`,
    );
    const key = boundedString(
      target.key,
      `Canonical matrix target ${index} key`,
      256,
    );
    return {
      key,
      adapter_id: boundedString(target.adapter_id, `${key} adapter_id`, 256),
      binding_id: boundedString(target.binding_id, `${key} binding_id`, 256),
      catalog_digest: catalogDigest(
        target.catalog_digest,
        `${key} catalog_digest`,
      ),
      requested_identity: structuredClone(
        jsonRecord(target.requested_identity, `${key} requested_identity`),
      ),
      expected_effective_identity: structuredClone(
        jsonRecord(
          target.expected_effective_identity,
          `${key} expected_effective_identity`,
        ),
      ),
      credential_family: boundedString(
        target.credential_family,
        `${key} credential_family`,
        256,
      ),
      pricing_snapshot_fingerprint: sha256(
        target.pricing_snapshot_fingerprint,
        `${key} pricing_snapshot_fingerprint`,
      ),
    };
  });
  const keys = targets.map((target) => target.key);
  if (
    targets.length !== 42 ||
    new Set(keys).size !== 42 ||
    canonicalJson(keys) !== canonicalJson([...keys].sort(compareText))
  ) {
    fail('Release candidate requires the exact sorted 42-profile matrix.');
  }
  const catalog = catalogDigest(
    matrix.catalog_digest,
    'Canonical catalog digest',
  );
  const pricing = sha256(
    matrix.pricing_snapshot_fingerprint,
    'Canonical pricing snapshot fingerprint',
  );
  if (
    targets.some(
      (target) =>
        target.catalog_digest !== catalog ||
        target.pricing_snapshot_fingerprint !== pricing,
    )
  ) {
    fail('Canonical target matrix fingerprints differ from their matrix.');
  }
  const fingerprint = sha256(
    matrix.fingerprint,
    'Canonical matrix fingerprint',
  );
  if (
    fingerprint !==
    sha256Bytes(
      canonicalJson({
        schema_version: 1,
        catalog_digest: catalog,
        pricing_snapshot_fingerprint: pricing,
        targets,
      }),
    )
  ) {
    fail('Canonical matrix fingerprint does not match its exact 42 targets.');
  }
  return {
    target_count: 42,
    catalog_digest: catalog,
    pricing_snapshot_fingerprint: pricing,
    matrix_fingerprint: fingerprint,
    targets,
  };
}

function parseMatrixIdentity(value: unknown): ReleaseMatrixIdentity {
  const identity = jsonRecord(value, 'Frozen installed-package identity');
  exactKeys(
    identity,
    [
      'catalog_digest',
      'matrix_fingerprint',
      'pricing_snapshot_fingerprint',
      'target_count',
      'targets',
    ],
    'Frozen installed-package identity',
  );
  if (identity.target_count !== 42 || !Array.isArray(identity.targets)) {
    fail('Frozen installed-package identity must contain exactly 42 targets.');
  }
  const targets = identity.targets.map((targetValue, index) => {
    const target = jsonRecord(
      targetValue,
      `Frozen installed-package target ${index}`,
    );
    exactKeys(
      target,
      [
        'adapter_id',
        'binding_id',
        'catalog_digest',
        'credential_family',
        'expected_effective_identity',
        'key',
        'pricing_snapshot_fingerprint',
        'requested_identity',
      ],
      `Frozen installed-package target ${index}`,
    );
    return {
      key: boundedString(target.key, `Frozen target ${index} key`, 256),
      adapter_id: boundedString(
        target.adapter_id,
        `Frozen target ${index} adapter_id`,
        256,
      ),
      binding_id: boundedString(
        target.binding_id,
        `Frozen target ${index} binding_id`,
        256,
      ),
      catalog_digest: catalogDigest(
        target.catalog_digest,
        `Frozen target ${index} catalog_digest`,
      ),
      requested_identity: structuredClone(
        jsonRecord(
          target.requested_identity,
          `Frozen target ${index} requested_identity`,
        ),
      ),
      expected_effective_identity: structuredClone(
        jsonRecord(
          target.expected_effective_identity,
          `Frozen target ${index} expected_effective_identity`,
        ),
      ),
      credential_family: boundedString(
        target.credential_family,
        `Frozen target ${index} credential_family`,
        256,
      ),
      pricing_snapshot_fingerprint: sha256(
        target.pricing_snapshot_fingerprint,
        `Frozen target ${index} pricing_snapshot_fingerprint`,
      ),
    };
  });
  const keys = targets.map((target) => target.key);
  if (
    targets.length !== 42 ||
    new Set(keys).size !== 42 ||
    canonicalJson(keys) !== canonicalJson([...keys].sort(compareText))
  ) {
    fail('Frozen installed-package targets must be unique and sorted.');
  }
  const catalog = catalogDigest(
    identity.catalog_digest,
    'Frozen catalog digest',
  );
  const pricing = sha256(
    identity.pricing_snapshot_fingerprint,
    'Frozen pricing snapshot fingerprint',
  );
  if (
    targets.some(
      (target) =>
        target.catalog_digest !== catalog ||
        target.pricing_snapshot_fingerprint !== pricing,
    )
  ) {
    fail('Frozen target matrix fingerprints differ from their matrix.');
  }
  const fingerprint = sha256(
    identity.matrix_fingerprint,
    'Frozen matrix fingerprint',
  );
  if (
    fingerprint !==
    sha256Bytes(
      canonicalJson({
        schema_version: 1,
        catalog_digest: catalog,
        pricing_snapshot_fingerprint: pricing,
        targets,
      }),
    )
  ) {
    fail('Frozen matrix fingerprint does not match its exact 42 targets.');
  }
  return {
    target_count: 42,
    catalog_digest: catalog,
    pricing_snapshot_fingerprint: pricing,
    matrix_fingerprint: fingerprint,
    targets,
  };
}

export function assertReleaseMatrixParity(
  sourceValue: unknown,
  installedValue: unknown,
): ReleaseMatrixIdentity {
  const source = matrixIdentity(sourceValue);
  const installed = matrixIdentity(installedValue);
  if (canonicalJson(source) !== canonicalJson(installed)) {
    fail('Source and installed-package canonical matrices differ.');
  }
  return installed;
}

async function defaultLoadSourceMatrix(
  _repositoryRoot: string,
): Promise<unknown> {
  return buildCanonicalValidationMatrix();
}

async function defaultLoadBuiltMatrix(
  repositoryRoot: string,
): Promise<unknown> {
  const entry = join(repositoryRoot, 'dist', 'node.js');
  if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) {
    fail('Freshly built package does not contain dist/node.js.');
  }
  const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission')
    ? '--permission'
    : process.allowedNodeEnvironmentFlags.has('--experimental-permission')
      ? '--experimental-permission'
      : undefined;
  if (!permissionFlag) {
    fail('Node permission isolation is required to probe the built matrix.');
  }
  const entryUrl = pathToFileURL(entry).href;
  const dependencyRoot = realpathSync(join(repositoryRoot, 'node_modules'));
  const probe = [
    `const module = await import(${JSON.stringify(entryUrl)});`,
    "if (typeof module.buildCanonicalValidationMatrix !== 'function') throw new Error('missing canonical matrix export');",
    'process.stdout.write(JSON.stringify(module.buildCanonicalValidationMatrix()));',
  ].join('\n');
  let source: string;
  try {
    source = execFileSync(
      process.execPath,
      [
        permissionFlag,
        `--allow-fs-read=${repositoryRoot}`,
        ...(dependencyRoot !== repositoryRoot
          ? [`--allow-fs-read=${dependencyRoot}`]
          : []),
        '--input-type=module',
        '--eval',
        probe,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          NODE_NO_WARNINGS: '1',
          ...(process.platform === 'win32' && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: MAX_JSON_BYTES,
      },
    );
  } catch {
    fail('Isolated installed-package matrix probe failed closed.');
  }
  try {
    return JSON.parse(source);
  } catch {
    fail('Isolated installed-package matrix probe returned invalid JSON.');
  }
}

async function defaultLoadInstalledMatrix(
  _repositoryRoot: string,
  packageFiles: ReadonlyMap<string, Uint8Array>,
): Promise<unknown> {
  const bytes = packageFiles.get('dist/release-matrix.json');
  if (!bytes || bytes.byteLength > MAX_JSON_BYTES) {
    fail('Installed package is missing its bounded canonical matrix receipt.');
  }
  const source = Buffer.from(bytes).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('Installed package matrix receipt is not valid JSON.');
  }
  if (canonicalText(parsed) !== source) {
    fail('Installed package matrix receipt is not canonical JSON.');
  }
  return parsed;
}

function expectedNpmInventory(repositoryRoot: string): string[] {
  const fixed = ['LICENSE', 'README.md', 'package.json'];
  const distRows = listRegularFiles(join(repositoryRoot, 'dist')).map(
    (row) => `dist/${row.path}`,
  );
  return [...fixed, ...distRows].sort(compareText);
}

function packageDeclarationEntrypoints(packageValue: unknown): string[] {
  const value = jsonRecord(packageValue, 'Packed package.json');
  const paths = new Set<string>();
  const add = (candidate: unknown, label: string): void => {
    if (typeof candidate !== 'string') return;
    const path = candidate.startsWith('./') ? candidate.slice(2) : candidate;
    const safe = normalizeRelativePath(path, label);
    if (!safe.endsWith('.d.ts')) {
      fail(`${label} must reference a .d.ts declaration.`);
    }
    paths.add(safe);
  };
  add(value.types, 'package.json types');
  const visit = (candidate: unknown, label: string): void => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      return;
    }
    for (const [key, child] of Object.entries(
      candidate as Record<string, unknown>,
    )) {
      if (key === 'types') add(child, `${label} types`);
      else visit(child, `${label}.${key}`);
    }
  };
  visit(value.exports, 'package.json exports');
  const required = [...paths].sort(compareText);
  if (required.length === 0) {
    fail('Packed package.json declares no public TypeScript entrypoint.');
  }
  return required;
}

function assertPackagedInventoryShape(tarRows: readonly TarFile[]): void {
  const actual = tarRows.map((row) => row.path);
  for (const fixed of ['LICENSE', 'README.md', 'package.json']) {
    if (!actual.includes(fixed)) {
      fail(`npm tarball is missing ${fixed}.`);
    }
  }
  if (
    actual.some(
      (path) =>
        !['LICENSE', 'README.md', 'package.json'].includes(path) &&
        !path.startsWith('dist/'),
    )
  ) {
    fail('npm tarball contains a file outside its exact public package roots.');
  }
  if (
    actual.some(
      (path) => path === 'contracts/v1' || path.startsWith('contracts/v1/'),
    )
  ) {
    fail('contracts/v1 must remain absent from the npm tarball.');
  }
  const declarations = actual.filter(
    (path) => path.endsWith('.d.ts') || path.endsWith('.d.ts.map'),
  );
  if (
    declarations.length === 0 ||
    declarations.includes('dist/cli.d.ts') ||
    declarations.includes('dist/cli.d.ts.map')
  ) {
    fail('npm tarball declaration inventory is invalid.');
  }
  const packedPackage = tarRows.find((row) => row.path === 'package.json');
  if (!packedPackage) fail('npm tarball is missing package.json.');
  let packageValue: unknown;
  try {
    packageValue = JSON.parse(
      Buffer.from(packedPackage.content).toString('utf8'),
    );
  } catch {
    fail('Packed package.json is invalid JSON.');
  }
  for (const required of packageDeclarationEntrypoints(packageValue)) {
    if (!declarations.includes(required)) {
      fail(`npm tarball is missing public declaration entrypoint ${required}.`);
    }
  }
}

function assertPackageInventory(
  repositoryRoot: string,
  tarRows: readonly TarFile[],
): void {
  assertPackagedInventoryShape(tarRows);
  const actual = tarRows.map((row) => row.path);
  const expected = expectedNpmInventory(repositoryRoot);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail('npm tarball inventory differs from the exact package inventory.');
  }
  for (const row of tarRows) {
    const sourcePath = join(repositoryRoot, ...row.path.split('/'));
    const stat = lstatSync(sourcePath, { throwIfNoEntry: false });
    if (
      !stat ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size !== row.size ||
      sha256Bytes(readFileSync(sourcePath)) !== row.sha256
    ) {
      fail(`npm tarball bytes differ from built source: ${row.path}.`);
    }
  }
}

function contractsSnapshot(repositoryRoot: string): {
  readonly fingerprint: string;
  readonly sourceRoot: string;
  readonly files: readonly FileRow[];
} {
  const sourceRoot = join(repositoryRoot, 'contracts', 'v1');
  const sourceRows = listRegularFiles(sourceRoot);
  if (
    sourceRows.length === 0 ||
    !sourceRows.some((row) => row.path === 'manifest.json') ||
    !sourceRows.some((row) => row.path === 'checksums.sha256') ||
    !sourceRows.some((row) => row.path === 'schema/interchange.schema.json')
  ) {
    fail('contracts/v1 inventory is incomplete.');
  }
  const files = sourceRows.map((row) => ({
    ...row,
    path: `contracts/v1/${row.path}`,
  }));
  return { fingerprint: sha256Bytes(canonicalJson(files)), sourceRoot, files };
}

function sourceReference(path: string, bytes: Uint8Array): ArtifactReference {
  return { path, sha256: sha256Bytes(bytes), size: bytes.byteLength };
}

function runDefault(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly capture?: boolean },
): string {
  return execFileSync(executable, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture
      ? ['ignore', 'pipe', 'inherit']
      : ['ignore', 'inherit', 'inherit'],
  }) as string;
}

function currentSource(
  repositoryRoot: string,
  dependencies: ReleaseCandidateDependencies,
): {
  readonly root: string;
  readonly git: ReleaseGitIdentity;
  readonly metadata: ReturnType<typeof packageMetadata>;
} {
  const root = safeExistingDirectory(repositoryRoot, 'Candidate repository');
  const git = (dependencies.read_git ?? readGit)(root);
  assertGitIdentity(git);
  return { root, git, metadata: packageMetadata(root) };
}

export async function freezeReleasePackage(input: {
  readonly repository_root: string;
  readonly output_root: string;
  readonly tarball: string;
  readonly dependencies?: ReleaseCandidateDependencies;
}): Promise<FrozenPackageManifest> {
  const dependencies = input.dependencies ?? {};
  const source = currentSource(input.repository_root, dependencies);
  const output = assertOutputAvailable(input.output_root, source.root);
  const tarballBytes = readBoundedFile(input.tarball, MAX_TAR_BYTES);
  const tarRows = parseNpmTarball(tarballBytes);
  assertPackageInventory(source.root, tarRows);
  const packedPackage = tarRows.find((row) => row.path === 'package.json');
  if (!packedPackage) fail('npm tarball is missing package.json.');
  const packedMetadata = jsonRecord(
    JSON.parse(Buffer.from(packedPackage.content).toString('utf8')),
    'Packed package.json',
  );
  if (
    !Buffer.from(packedPackage.content).equals(source.metadata.packageJson) ||
    packedMetadata.name !== source.metadata.name ||
    packedMetadata.version !== source.metadata.version
  ) {
    fail('npm tarball package.json bytes differ from the candidate source.');
  }
  const sourceMatrix = await (
    dependencies.load_source_matrix ?? defaultLoadSourceMatrix
  )(source.root);
  const installedMatrix = await (
    dependencies.load_installed_matrix ?? defaultLoadInstalledMatrix
  )(source.root, packageContents(tarRows));
  const installedPackage = assertReleaseMatrixParity(
    sourceMatrix,
    installedMatrix,
  );
  const contracts = contractsSnapshot(source.root);
  const tarballName = `${source.metadata.name}-${source.metadata.version}.tgz`;
  if (basename(input.tarball) !== tarballName) {
    fail('npm tarball name differs from the exact package name and version.');
  }
  const packageRows = publicPackageRows(tarRows);
  const declarations = packageRows.filter(
    (row) => row.path.endsWith('.d.ts') || row.path.endsWith('.d.ts.map'),
  );
  const manifest: FrozenPackageManifest = {
    schema_version: 1,
    contract: 'librarium-frozen-package',
    candidate: {
      name: source.metadata.name,
      version: source.metadata.version,
      git_sha: source.git.sha,
      git_tree: source.git.tree,
    },
    source_metadata: {
      package_json: sourceReference(
        'source/package.json',
        source.metadata.packageJson,
      ),
      package_lock: {
        ...sourceReference(
          'source/package-lock.json',
          source.metadata.packageLock,
        ),
        lockfile_version: source.metadata.lockfileVersion,
      },
    },
    npm: {
      tarball: sourceReference(`npm/${tarballName}`, tarballBytes),
      inventory: packageRows,
      declarations,
    },
    contracts_v1: {
      fingerprint: contracts.fingerprint,
      files: contracts.files,
    },
    installed_package: installedPackage,
  };
  mkdirSync(output, { mode: 0o755 });
  try {
    writeExclusive(
      join(output, FROZEN_PACKAGE_MANIFEST),
      canonicalText(manifest),
    );
    writeExclusive(
      join(output, ...manifest.source_metadata.package_json.path.split('/')),
      source.metadata.packageJson,
    );
    writeExclusive(
      join(output, ...manifest.source_metadata.package_lock.path.split('/')),
      source.metadata.packageLock,
    );
    writeExclusive(
      join(output, ...manifest.npm.tarball.path.split('/')),
      tarballBytes,
    );
    for (const row of contracts.files) {
      const sourcePath = join(
        contracts.sourceRoot,
        ...row.path.slice('contracts/v1/'.length).split('/'),
      );
      copyExclusive(sourcePath, join(output, ...row.path.split('/')));
    }
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

export async function buildFrozenReleasePackage(input: {
  readonly repository_root: string;
  readonly output_root: string;
  readonly dependencies?: ReleaseCandidateDependencies;
}): Promise<FrozenPackageManifest> {
  const dependencies = input.dependencies ?? {};
  const source = currentSource(input.repository_root, dependencies);
  assertOutputAvailable(input.output_root, source.root);
  const run = dependencies.run ?? runDefault;
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: source.root,
  });
  const trustedMatrix = await (
    dependencies.load_source_matrix ?? defaultLoadSourceMatrix
  )(source.root);
  const builtMatrix = await (
    dependencies.load_built_matrix ?? defaultLoadBuiltMatrix
  )(source.root);
  assertReleaseMatrixParity(trustedMatrix, builtMatrix);
  writeExclusive(
    join(source.root, 'dist', 'release-matrix.json'),
    canonicalText(builtMatrix),
  );
  const afterBuild = currentSource(source.root, dependencies);
  if (
    afterBuild.git.sha !== source.git.sha ||
    afterBuild.git.tree !== source.git.tree ||
    afterBuild.metadata.version !== source.metadata.version
  ) {
    fail('Candidate source drifted while building frozen package bytes.');
  }
  const packRoot = mkdtempSync(join(tmpdir(), 'librarium-rc-pack-'));
  try {
    const output = run(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', packRoot],
      { cwd: source.root, capture: true },
    );
    let result: unknown;
    try {
      result = JSON.parse(output);
    } catch {
      fail('npm pack did not return its exact JSON inventory.');
    }
    if (!Array.isArray(result) || result.length !== 1) {
      fail('Release packaging requires exactly one npm tarball.');
    }
    const row = jsonRecord(result[0], 'npm pack result');
    const filename = boundedString(row.filename, 'npm pack filename', 256);
    if (
      filename !== basename(filename) ||
      !SAFE_SEGMENT_PATTERN.test(filename)
    ) {
      fail('npm pack returned an unsafe tarball filename.');
    }
    return await freezeReleasePackage({
      repository_root: source.root,
      output_root: input.output_root,
      tarball: join(packRoot, filename),
      dependencies,
    });
  } finally {
    rmSync(packRoot, { recursive: true, force: true });
  }
}

function parseFrozenPackage(value: unknown): FrozenPackageManifest {
  const manifest = jsonRecord(value, 'Frozen package manifest');
  exactKeys(
    manifest,
    [
      'candidate',
      'contract',
      'contracts_v1',
      'installed_package',
      'npm',
      'schema_version',
      'source_metadata',
    ],
    'Frozen package manifest',
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.contract !== 'librarium-frozen-package'
  ) {
    fail('Frozen package contract version is unsupported.');
  }
  const candidate = jsonRecord(manifest.candidate, 'Frozen package candidate');
  exactKeys(
    candidate,
    ['git_sha', 'git_tree', 'name', 'version'],
    'Frozen package candidate',
  );
  const sourceMetadata = jsonRecord(
    manifest.source_metadata,
    'Frozen source metadata',
  );
  exactKeys(
    sourceMetadata,
    ['package_json', 'package_lock'],
    'Frozen source metadata',
  );
  const packageLock = jsonRecord(
    sourceMetadata.package_lock,
    'Frozen package lock',
  );
  exactKeys(
    packageLock,
    ['lockfile_version', 'path', 'sha256', 'size'],
    'Frozen package lock',
  );
  const npm = jsonRecord(manifest.npm, 'Frozen npm package');
  exactKeys(
    npm,
    ['declarations', 'inventory', 'tarball'],
    'Frozen npm package',
  );
  const contracts = jsonRecord(manifest.contracts_v1, 'Frozen contracts/v1');
  exactKeys(contracts, ['files', 'fingerprint'], 'Frozen contracts/v1');
  if (
    !Array.isArray(npm.inventory) ||
    !Array.isArray(npm.declarations) ||
    !Array.isArray(contracts.files)
  ) {
    fail('Frozen package inventories must be arrays.');
  }
  const inventory = npm.inventory.map((row, index) =>
    packageFileRow(row, `Frozen npm inventory ${index}`),
  );
  const declarations = npm.declarations.map((row, index) =>
    packageFileRow(row, `Frozen declaration inventory ${index}`),
  );
  const contractFiles = contracts.files.map((row, index) =>
    fileRow(row, `Frozen contract inventory ${index}`),
  );
  assertUniqueSortedPaths(inventory, 'Frozen npm inventory');
  assertUniqueSortedPaths(declarations, 'Frozen declaration inventory');
  assertUniqueSortedPaths(contractFiles, 'Frozen contracts inventory');
  if (
    contractFiles.length === 0 ||
    contractFiles.some((row) => !row.path.startsWith('contracts/v1/')) ||
    !contractFiles.some((row) => row.path === 'contracts/v1/manifest.json') ||
    !contractFiles.some(
      (row) => row.path === 'contracts/v1/checksums.sha256',
    ) ||
    !contractFiles.some(
      (row) => row.path === 'contracts/v1/schema/interchange.schema.json',
    )
  ) {
    fail('Frozen contracts/v1 inventory is incomplete or unsafe.');
  }
  const version = boundedString(
    candidate.version,
    'Frozen candidate version',
    128,
  );
  assertReleaseCandidateVersion(version);
  const gitSha = boundedString(candidate.git_sha, 'Frozen Git SHA', 40);
  const gitTree = boundedString(candidate.git_tree, 'Frozen Git tree', 40);
  if (!/^[0-9a-f]{40}$/.test(gitSha) || !/^[0-9a-f]{40}$/.test(gitTree)) {
    fail('Frozen Git identity is invalid.');
  }
  const lockReference = artifactReferenceFields(
    packageLock,
    'Frozen package lock',
  );
  const packageJsonReference = artifactReference(
    sourceMetadata.package_json,
    'Frozen package.json',
  );
  const npmTarballReference = artifactReference(
    npm.tarball,
    'Frozen npm tarball',
  );
  const packageName = boundedString(candidate.name, 'Frozen package name', 214);
  if (
    packageJsonReference.path !== 'source/package.json' ||
    lockReference.path !== 'source/package-lock.json' ||
    npmTarballReference.path !== `npm/${packageName}-${version}.tgz`
  ) {
    fail('Frozen package uses a noncanonical artifact path.');
  }
  return {
    schema_version: 1,
    contract: 'librarium-frozen-package',
    candidate: {
      name: packageName,
      version,
      git_sha: gitSha,
      git_tree: gitTree,
    },
    source_metadata: {
      package_json: packageJsonReference,
      package_lock: {
        ...lockReference,
        lockfile_version: safeInteger(
          packageLock.lockfile_version,
          'Frozen lockfile version',
        ),
      },
    },
    npm: {
      tarball: npmTarballReference,
      inventory,
      declarations,
    },
    contracts_v1: {
      fingerprint: sha256(
        contracts.fingerprint,
        'Frozen contracts fingerprint',
      ),
      files: contractFiles,
    },
    installed_package: parseMatrixIdentity(manifest.installed_package),
  };
}

function verifyReference(root: string, reference: ArtifactReference): Buffer {
  if (reference.size > MAX_TAR_BYTES) {
    fail(`Release artifact is too large: ${reference.path}.`);
  }
  const path = join(
    root,
    ...normalizeRelativePath(reference.path, 'Artifact reference').split('/'),
  );
  if (!contained(root, path)) fail('Artifact reference escapes its root.');
  const bytes = readBoundedFile(path, MAX_TAR_BYTES);
  if (
    bytes.byteLength !== reference.size ||
    sha256Bytes(bytes) !== reference.sha256
  ) {
    fail(`Release artifact bytes drifted: ${reference.path}.`);
  }
  return bytes;
}

async function verifyFrozenPackage(
  packageRootInput: string,
  repositoryRootInput: string,
  dependencies: ReleaseCandidateDependencies,
): Promise<{
  readonly manifest: FrozenPackageManifest;
  readonly tarRows: TarFile[];
}> {
  const packageRoot = safeExistingDirectory(
    packageRootInput,
    'Frozen package root',
  );
  const source = currentSource(repositoryRootInput, dependencies);
  const manifest = parseFrozenPackage(
    readCanonicalJson(
      join(packageRoot, FROZEN_PACKAGE_MANIFEST),
      'Frozen package manifest',
    ),
  );
  if (
    manifest.candidate.git_sha !== source.git.sha ||
    manifest.candidate.git_tree !== source.git.tree ||
    manifest.candidate.name !== source.metadata.name ||
    manifest.candidate.version !== source.metadata.version
  ) {
    fail('Frozen package source identity differs from the clean repository.');
  }
  const packageJsonBytes = verifyReference(
    packageRoot,
    manifest.source_metadata.package_json,
  );
  const packageLockBytes = verifyReference(
    packageRoot,
    manifest.source_metadata.package_lock,
  );
  if (
    !packageJsonBytes.equals(source.metadata.packageJson) ||
    !packageLockBytes.equals(source.metadata.packageLock) ||
    manifest.source_metadata.package_lock.lockfile_version !==
      source.metadata.lockfileVersion
  ) {
    fail('Frozen package metadata bytes differ from the clean repository.');
  }
  const tarballBytes = verifyReference(packageRoot, manifest.npm.tarball);
  const tarRows = parseNpmTarball(tarballBytes);
  assertPackagedInventoryShape(tarRows);
  const packedPackage = tarRows.find((row) => row.path === 'package.json');
  if (
    !packedPackage ||
    !Buffer.from(packedPackage.content).equals(packageJsonBytes)
  ) {
    fail('Frozen npm package.json bytes differ from the clean repository.');
  }
  if (
    canonicalJson(publicPackageRows(tarRows)) !==
    canonicalJson(manifest.npm.inventory)
  ) {
    fail('Frozen npm package inventory drifted.');
  }
  const declarations = publicPackageRows(tarRows).filter(
    (row) => row.path.endsWith('.d.ts') || row.path.endsWith('.d.ts.map'),
  );
  if (
    canonicalJson(declarations) !== canonicalJson(manifest.npm.declarations)
  ) {
    fail('Frozen declaration inventory drifted.');
  }
  for (const row of manifest.contracts_v1.files)
    verifyReference(packageRoot, row);
  const sourceContracts = contractsSnapshot(source.root);
  if (
    sha256Bytes(canonicalJson(manifest.contracts_v1.files)) !==
      manifest.contracts_v1.fingerprint ||
    canonicalJson(manifest.contracts_v1.files) !==
      canonicalJson(sourceContracts.files) ||
    manifest.contracts_v1.fingerprint !== sourceContracts.fingerprint
  ) {
    fail('Frozen contracts/v1 inventory differs from its exact Git source.');
  }
  const sourceMatrix = await (
    dependencies.load_source_matrix ?? defaultLoadSourceMatrix
  )(source.root);
  const installedMatrix = await (
    dependencies.load_installed_matrix ?? defaultLoadInstalledMatrix
  )(source.root, packageContents(tarRows));
  const identity = assertReleaseMatrixParity(sourceMatrix, installedMatrix);
  if (canonicalJson(identity) !== canonicalJson(manifest.installed_package)) {
    fail('Frozen installed-package matrix or pricing identity drifted.');
  }
  const expectedPaths = [
    FROZEN_PACKAGE_MANIFEST,
    manifest.source_metadata.package_json.path,
    manifest.source_metadata.package_lock.path,
    manifest.npm.tarball.path,
    ...manifest.contracts_v1.files.map((row) => row.path),
  ].sort(compareText);
  const actualPaths = listRegularFiles(packageRoot).map((row) => row.path);
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    fail('Frozen package root has a missing or extra artifact.');
  }
  return { manifest, tarRows };
}

function exactSeaRows(seaRootInput: string): Array<
  ArtifactReference & {
    readonly platform: string;
    readonly arch: string;
    readonly name: string;
  }
> {
  const seaRoot = safeExistingDirectory(seaRootInput, 'SEA artifact root');
  const inventory = listRegularFiles(seaRoot);
  const actual = inventory.map((row) => row.path);
  const expected = RELEASE_CANDIDATE_SEA_TARGETS.map((row) => row.name).sort(
    compareText,
  );
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail('SEA artifact root must contain the exact five release binaries.');
  }
  return RELEASE_CANDIDATE_SEA_TARGETS.map((target) => {
    const row = inventory.find((candidate) => candidate.path === target.name)!;
    if (row.size === 0) fail('SEA binary must not be empty.');
    assertSeaBinary(
      join(seaRoot, target.name),
      target.platform,
      target.arch,
      `SEA ${target.name}`,
    );
    return {
      platform: target.platform,
      arch: target.arch,
      name: target.name,
      path: `sea/${target.name}`,
      sha256: row.sha256,
      size: row.size,
    };
  });
}

function assertSeaBinary(
  path: string,
  platform: string,
  arch: string,
  label: string,
): void {
  const bytes = readBoundedFile(path, MAX_TAR_BYTES);
  const mode = statSync(path).mode;
  if (
    process.platform !== 'win32' &&
    platform !== 'win32' &&
    (mode & 0o111) === 0
  ) {
    fail(`${label} must have an executable mode.`);
  }
  if (platform === 'linux') {
    const expectedMachine = arch === 'x64' ? 62 : arch === 'arm64' ? 183 : -1;
    if (
      bytes.byteLength < 20 ||
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== expectedMachine
    ) {
      fail(`${label} is not the expected 64-bit ELF binary.`);
    }
    return;
  }
  if (platform === 'darwin') {
    const expectedCpu =
      arch === 'x64' ? 0x0100_0007 : arch === 'arm64' ? 0x0100_000c : -1;
    if (
      bytes.byteLength < 8 ||
      bytes.readUInt32LE(0) !== 0xfeed_facf ||
      bytes.readUInt32LE(4) !== expectedCpu
    ) {
      fail(`${label} is not the expected 64-bit Mach-O binary.`);
    }
    return;
  }
  if (platform === 'win32' && arch === 'x64') {
    if (bytes.byteLength < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
      fail(`${label} is not the expected x64 PE binary.`);
    }
    const header = bytes.readUInt32LE(0x3c);
    if (
      header + 6 > bytes.byteLength ||
      bytes.readUInt32LE(header) !== 0x0000_4550 ||
      bytes.readUInt16LE(header + 4) !== 0x8664
    ) {
      fail(`${label} is not the expected x64 PE binary.`);
    }
    return;
  }
  fail(`${label} uses an unsupported SEA platform or architecture.`);
}

function attestationSubjects(
  npm: ArtifactReference,
  seaRows: readonly (ArtifactReference & { readonly name: string })[],
): Array<{
  readonly name: string;
  readonly digest: { readonly sha256: string };
}> {
  return [
    { name: npm.path, digest: { sha256: npm.sha256.slice('sha256:'.length) } },
    ...seaRows.map((row) => ({
      name: row.path,
      digest: { sha256: row.sha256.slice('sha256:'.length) },
    })),
  ].sort((left, right) => compareText(left.name, right.name));
}

function provenanceStatement(
  manifest: Pick<
    FrozenPackageManifest,
    'candidate' | 'contracts_v1' | 'npm' | 'source_metadata'
  >,
  seaRows: readonly (ArtifactReference & { readonly name: string })[],
): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: attestationSubjects(manifest.npm.tarball, seaRows),
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://librarium.agentsy.build/release-candidate/v1',
        externalParameters: {
          git_sha: manifest.candidate.git_sha,
          git_tree: manifest.candidate.git_tree,
          version: manifest.candidate.version,
        },
        internalParameters: {},
        resolvedDependencies: [
          {
            uri: `git+https://github.com/jkudish/librarium@${manifest.candidate.git_sha}`,
            digest: { gitTree: manifest.candidate.git_tree },
          },
          {
            uri: 'file:source/package.json',
            digest: {
              sha256: manifest.source_metadata.package_json.sha256.slice(7),
            },
          },
          {
            uri: 'file:source/package-lock.json',
            digest: {
              sha256: manifest.source_metadata.package_lock.sha256.slice(7),
            },
          },
          {
            uri: 'file:contracts/v1',
            digest: { sha256: manifest.contracts_v1.fingerprint.slice(7) },
          },
        ],
      },
      runDetails: {
        builder: {
          id: `https://github.com/jkudish/librarium/tree/${manifest.candidate.git_sha}/scripts/rc-artifacts`,
        },
      },
    },
  };
}

function liveAuthorityFingerprint(
  manifest: Pick<FrozenPackageManifest, 'candidate' | 'source_metadata'>,
  artifactHashes: Readonly<Record<string, string>>,
): string {
  return sha256Bytes(
    JSON.stringify({
      head: manifest.candidate.git_sha,
      tree: manifest.candidate.git_tree,
      version: manifest.candidate.version,
      package: manifest.source_metadata.package_json.sha256,
      artifacts: artifactHashes,
    }),
  );
}

export async function assembleReleaseCandidate(input: {
  readonly repository_root: string;
  readonly package_root: string;
  readonly sea_root: string;
  readonly output_root: string;
  readonly dependencies?: ReleaseCandidateDependencies;
}): Promise<CandidateManifest> {
  const dependencies = input.dependencies ?? {};
  const repositoryRoot = safeExistingDirectory(
    input.repository_root,
    'Candidate repository',
  );
  const packageRoot = safeExistingDirectory(
    input.package_root,
    'Frozen package root',
  );
  const seaRoot = safeExistingDirectory(input.sea_root, 'SEA artifact root');
  const output = assertOutputAvailable(input.output_root, repositoryRoot, [
    packageRoot,
    seaRoot,
  ]);
  const { manifest: frozen } = await verifyFrozenPackage(
    packageRoot,
    repositoryRoot,
    dependencies,
  );
  const seaRows = exactSeaRows(seaRoot);
  mkdirSync(output, { mode: 0o755 });
  try {
    for (const reference of [
      frozen.source_metadata.package_json,
      frozen.source_metadata.package_lock,
      frozen.npm.tarball,
      ...frozen.contracts_v1.files,
    ]) {
      copyExclusive(
        join(packageRoot, ...reference.path.split('/')),
        join(output, ...reference.path.split('/')),
      );
    }
    for (const row of seaRows) {
      copyExclusive(
        join(seaRoot, row.name),
        join(output, ...row.path.split('/')),
      );
      if (row.platform !== 'win32')
        chmodSync(join(output, ...row.path.split('/')), 0o755);
    }
    const records: Record<string, unknown> = {
      declarations: {
        schema_version: 1,
        kind: 'declarations',
        npm_tarball: frozen.npm.tarball,
        files: frozen.npm.declarations,
      },
      npm_tarball: {
        schema_version: 1,
        kind: 'npm_tarball',
        artifact: frozen.npm.tarball,
        package_json_sha256: frozen.source_metadata.package_json.sha256,
        package_lock_sha256: frozen.source_metadata.package_lock.sha256,
      },
      package_inventory: {
        schema_version: 1,
        kind: 'package_inventory',
        npm_tarball: frozen.npm.tarball,
        files: frozen.npm.inventory,
        installed_package: frozen.installed_package,
      },
      provenance: provenanceStatement(frozen, seaRows),
      sea_manifest: {
        schema_version: 1,
        kind: 'sea_manifest',
        rows: seaRows,
      },
    };
    const recordReferences: Record<string, ArtifactReference> = {};
    for (const name of RELEASE_CANDIDATE_RECORD_NAMES) {
      const path = `records/${name}.json`;
      const bytes = canonicalText(records[name]);
      writeExclusive(join(output, ...path.split('/')), bytes);
      recordReferences[name] = sourceReference(path, Buffer.from(bytes));
    }
    const artifactHashes = Object.fromEntries(
      RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
        name,
        recordReferences[name]!.sha256,
      ]),
    );
    const fingerprint = liveAuthorityFingerprint(frozen, artifactHashes);
    const candidate: CandidateManifest = {
      ...frozen,
      contract: 'librarium-release-candidate',
      candidate: { ...frozen.candidate, fingerprint },
      sea: { rows: seaRows },
      provenance: {
        path: recordReferences.provenance!.path,
        sha256: recordReferences.provenance!.sha256,
        subject_count: 6,
      },
      live_validation: {
        record_names: [...RELEASE_CANDIDATE_RECORD_NAMES],
        records: recordReferences,
        artifact_hashes: artifactHashes,
      },
      checksum_index: { path: CHECKSUM_INDEX, algorithm: 'sha256' },
    };
    writeExclusive(join(output, CANDIDATE_MANIFEST), canonicalText(candidate));
    const checksumRows = listRegularFiles(output)
      .filter((row) => row.path !== CHECKSUM_INDEX)
      .map((row) => `${row.sha256.slice(7)}  ${row.path}`);
    writeExclusive(
      join(output, CHECKSUM_INDEX),
      `${checksumRows.join('\n')}\n`,
    );
    return candidate;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function parseChecksums(root: string): Map<string, string> {
  const source = readBoundedFile(join(root, CHECKSUM_INDEX)).toString('utf8');
  if (!source.endsWith('\n')) fail('SHA256SUMS must end with one newline.');
  const lines = source.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => !line)) {
    fail('SHA256SUMS is empty or malformed.');
  }
  const checksums = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) fail('SHA256SUMS contains a malformed row.');
    const path = normalizeRelativePath(match[2]!, 'SHA256SUMS path');
    if (path === CHECKSUM_INDEX || checksums.has(path)) {
      fail('SHA256SUMS contains a duplicate or recursive row.');
    }
    checksums.set(path, `sha256:${match[1]}`);
  }
  const paths = [...checksums.keys()];
  if (canonicalJson(paths) !== canonicalJson([...paths].sort(compareText))) {
    fail('SHA256SUMS must be sorted by artifact path.');
  }
  return checksums;
}

function parseCandidateManifest(value: unknown): CandidateManifest {
  const manifest = jsonRecord(value, 'Release candidate manifest');
  exactKeys(
    manifest,
    [
      'candidate',
      'checksum_index',
      'contract',
      'contracts_v1',
      'installed_package',
      'live_validation',
      'npm',
      'provenance',
      'schema_version',
      'sea',
      'source_metadata',
    ],
    'Release candidate manifest',
  );
  if (manifest.contract !== 'librarium-release-candidate') {
    fail('Release candidate contract is unsupported.');
  }
  const candidate = jsonRecord(
    manifest.candidate,
    'Release candidate identity',
  );
  exactKeys(
    candidate,
    ['fingerprint', 'git_sha', 'git_tree', 'name', 'version'],
    'Release candidate identity',
  );
  const frozenValue = {
    ...manifest,
    contract: 'librarium-frozen-package',
    candidate: {
      name: candidate.name,
      version: candidate.version,
      git_sha: candidate.git_sha,
      git_tree: candidate.git_tree,
    },
  } as Record<string, unknown>;
  delete frozenValue.checksum_index;
  delete frozenValue.live_validation;
  delete frozenValue.provenance;
  delete frozenValue.sea;
  const frozen = parseFrozenPackage(frozenValue);
  const sea = jsonRecord(manifest.sea, 'Release SEA manifest');
  exactKeys(sea, ['rows'], 'Release SEA manifest');
  if (!Array.isArray(sea.rows)) fail('Release SEA rows must be an array.');
  const seaRows = sea.rows.map((value, index) => {
    const row = jsonRecord(value, `Release SEA row ${index}`);
    exactKeys(
      row,
      ['arch', 'name', 'path', 'platform', 'sha256', 'size'],
      `Release SEA row ${index}`,
    );
    return {
      ...artifactReferenceFields(row, `Release SEA row ${index}`),
      platform: boundedString(
        row.platform,
        `Release SEA row ${index} platform`,
        16,
      ),
      arch: boundedString(row.arch, `Release SEA row ${index} arch`, 16),
      name: boundedString(row.name, `Release SEA row ${index} name`, 128),
    };
  });
  const provenance = jsonRecord(manifest.provenance, 'Release provenance');
  exactKeys(
    provenance,
    ['path', 'sha256', 'subject_count'],
    'Release provenance',
  );
  const live = jsonRecord(
    manifest.live_validation,
    'Release live-validation records',
  );
  exactKeys(
    live,
    ['artifact_hashes', 'record_names', 'records'],
    'Release live-validation records',
  );
  if (!Array.isArray(live.record_names))
    fail('Live-validation record names must be an array.');
  const names = live.record_names.map((name, index) =>
    boundedString(name, `Live-validation record ${index}`, 64),
  );
  if (canonicalJson(names) !== canonicalJson(RELEASE_CANDIDATE_RECORD_NAMES)) {
    fail(
      'Release candidate must contain the exact five live-validation records.',
    );
  }
  const recordsValue = jsonRecord(live.records, 'Live-validation record map');
  const hashesValue = jsonRecord(
    live.artifact_hashes,
    'Live-validation hash map',
  );
  exactKeys(
    recordsValue,
    RELEASE_CANDIDATE_RECORD_NAMES,
    'Live-validation record map',
  );
  exactKeys(
    hashesValue,
    RELEASE_CANDIDATE_RECORD_NAMES,
    'Live-validation hash map',
  );
  const records = Object.fromEntries(
    RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
      name,
      artifactReference(recordsValue[name], `Live-validation ${name} record`),
    ]),
  );
  const hashes = Object.fromEntries(
    RELEASE_CANDIDATE_RECORD_NAMES.map((name) => [
      name,
      sha256(hashesValue[name], `Live-validation ${name} hash`),
    ]),
  );
  const checksumIndex = jsonRecord(
    manifest.checksum_index,
    'Release checksum index',
  );
  exactKeys(checksumIndex, ['algorithm', 'path'], 'Release checksum index');
  if (
    checksumIndex.algorithm !== 'sha256' ||
    checksumIndex.path !== CHECKSUM_INDEX
  ) {
    fail('Release checksum index contract is invalid.');
  }
  if (provenance.subject_count !== 6)
    fail('Release provenance subject count must be six.');
  return {
    ...frozen,
    contract: 'librarium-release-candidate',
    candidate: {
      ...frozen.candidate,
      fingerprint: sha256(
        candidate.fingerprint,
        'Release candidate fingerprint',
      ),
    },
    sea: { rows: seaRows },
    provenance: {
      path: normalizeRelativePath(
        boundedString(provenance.path, 'Release provenance path'),
        'Release provenance path',
      ),
      sha256: sha256(provenance.sha256, 'Release provenance hash'),
      subject_count: 6,
    },
    live_validation: {
      record_names: names,
      records,
      artifact_hashes: hashes,
    },
    checksum_index: { path: CHECKSUM_INDEX, algorithm: 'sha256' },
  };
}

function verifyCanonicalRecord(
  root: string,
  reference: ArtifactReference,
  label: string,
): unknown {
  const bytes = verifyReference(root, reference);
  const path = join(root, ...reference.path.split('/'));
  const parsed = readCanonicalJson(path, label);
  if (sha256Bytes(bytes) !== reference.sha256) fail(`${label} hash drifted.`);
  return parsed;
}

function assertArtifactRecord(
  value: unknown,
  kind: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const record = jsonRecord(value, `${kind} record`);
  exactKeys(record, expectedKeys, `${kind} record`);
  if (record.schema_version !== 1 || record.kind !== kind) {
    fail(`${kind} record contract is invalid.`);
  }
  return record;
}

export async function verifyReleaseCandidate(input: {
  readonly repository_root: string;
  readonly candidate_root: string;
  readonly dependencies?: ReleaseCandidateDependencies;
}): Promise<CandidateManifest> {
  const dependencies = input.dependencies ?? {};
  const root = safeExistingDirectory(
    input.candidate_root,
    'Release candidate root',
  );
  const inventory = listRegularFiles(root);
  const checksums = parseChecksums(root);
  const actualPaths = inventory
    .map((row) => row.path)
    .filter((path) => path !== CHECKSUM_INDEX);
  if (canonicalJson([...checksums.keys()]) !== canonicalJson(actualPaths)) {
    fail('Release candidate has a missing or extra checksummed artifact.');
  }
  for (const row of inventory) {
    if (row.path === CHECKSUM_INDEX) continue;
    if (checksums.get(row.path) !== row.sha256) {
      fail(`SHA256SUMS drifted for ${row.path}.`);
    }
  }
  const manifest = parseCandidateManifest(
    readCanonicalJson(
      join(root, CANDIDATE_MANIFEST),
      'Release candidate manifest',
    ),
  );
  const source = currentSource(input.repository_root, dependencies);
  if (
    source.git.sha !== manifest.candidate.git_sha ||
    source.git.tree !== manifest.candidate.git_tree ||
    source.metadata.name !== manifest.candidate.name ||
    source.metadata.version !== manifest.candidate.version
  ) {
    fail('Release candidate differs from its exact clean Git source.');
  }
  const packageJsonBytes = verifyReference(
    root,
    manifest.source_metadata.package_json,
  );
  const packageLockBytes = verifyReference(
    root,
    manifest.source_metadata.package_lock,
  );
  if (
    !packageJsonBytes.equals(source.metadata.packageJson) ||
    !packageLockBytes.equals(source.metadata.packageLock) ||
    manifest.source_metadata.package_lock.lockfile_version !==
      source.metadata.lockfileVersion
  ) {
    fail('Release candidate package or lock metadata drifted.');
  }
  const tarballBytes = verifyReference(root, manifest.npm.tarball);
  const tarRows = parseNpmTarball(tarballBytes);
  assertPackagedInventoryShape(tarRows);
  const packedPackage = tarRows.find((row) => row.path === 'package.json');
  if (
    !packedPackage ||
    !Buffer.from(packedPackage.content).equals(packageJsonBytes)
  ) {
    fail('Release candidate npm package.json differs from its clean source.');
  }
  const packageRows = publicPackageRows(tarRows);
  if (canonicalJson(packageRows) !== canonicalJson(manifest.npm.inventory)) {
    fail('Release candidate npm inventory drifted.');
  }
  const declarations = packageRows.filter(
    (row) => row.path.endsWith('.d.ts') || row.path.endsWith('.d.ts.map'),
  );
  if (
    canonicalJson(declarations) !== canonicalJson(manifest.npm.declarations)
  ) {
    fail('Release candidate declaration inventory drifted.');
  }
  for (const row of manifest.contracts_v1.files) verifyReference(root, row);
  const sourceContracts = contractsSnapshot(source.root);
  if (
    sha256Bytes(canonicalJson(manifest.contracts_v1.files)) !==
      manifest.contracts_v1.fingerprint ||
    canonicalJson(manifest.contracts_v1.files) !==
      canonicalJson(sourceContracts.files) ||
    manifest.contracts_v1.fingerprint !== sourceContracts.fingerprint ||
    packageRows.some(
      (row) =>
        row.path === 'contracts/v1' || row.path.startsWith('contracts/v1/'),
    )
  ) {
    fail(
      'Release candidate contracts/v1 inventory differs from its exact Git source or package exclusion.',
    );
  }
  const sourceMatrix = await (
    dependencies.load_source_matrix ?? defaultLoadSourceMatrix
  )(source.root);
  const installedMatrix = await (
    dependencies.load_installed_matrix ?? defaultLoadInstalledMatrix
  )(source.root, packageContents(tarRows));
  const matrix = assertReleaseMatrixParity(sourceMatrix, installedMatrix);
  if (canonicalJson(matrix) !== canonicalJson(manifest.installed_package)) {
    fail('Release candidate matrix, catalog, or pricing fingerprint drifted.');
  }
  if (
    manifest.sea.rows.length !== RELEASE_CANDIDATE_SEA_TARGETS.length ||
    canonicalJson(
      manifest.sea.rows.map(({ platform, arch, name, path }) => ({
        platform,
        arch,
        name,
        path,
      })),
    ) !==
      canonicalJson(
        RELEASE_CANDIDATE_SEA_TARGETS.map((row) => ({
          ...row,
          path: `sea/${row.name}`,
        })),
      )
  ) {
    fail('Release candidate SEA matrix differs from the exact five rows.');
  }
  for (const row of manifest.sea.rows) {
    verifyReference(root, row);
    assertSeaBinary(
      join(root, ...row.path.split('/')),
      row.platform,
      row.arch,
      `SEA ${row.name}`,
    );
  }
  for (const name of RELEASE_CANDIDATE_RECORD_NAMES) {
    const reference = manifest.live_validation.records[name]!;
    if (
      reference.path !== `records/${name}.json` ||
      reference.sha256 !== manifest.live_validation.artifact_hashes[name]
    ) {
      fail(`Live-validation ${name} record mapping drifted.`);
    }
  }
  const npmRecord = assertArtifactRecord(
    verifyCanonicalRecord(
      root,
      manifest.live_validation.records.npm_tarball!,
      'npm tarball record',
    ),
    'npm_tarball',
    [
      'artifact',
      'kind',
      'package_json_sha256',
      'package_lock_sha256',
      'schema_version',
    ],
  );
  if (
    canonicalJson(
      artifactReference(npmRecord.artifact, 'npm tarball record artifact'),
    ) !== canonicalJson(manifest.npm.tarball) ||
    npmRecord.package_json_sha256 !==
      manifest.source_metadata.package_json.sha256 ||
    npmRecord.package_lock_sha256 !==
      manifest.source_metadata.package_lock.sha256
  ) {
    fail('npm tarball record drifted from its referenced bytes.');
  }
  const inventoryRecord = assertArtifactRecord(
    verifyCanonicalRecord(
      root,
      manifest.live_validation.records.package_inventory!,
      'package inventory record',
    ),
    'package_inventory',
    ['files', 'installed_package', 'kind', 'npm_tarball', 'schema_version'],
  );
  if (
    canonicalJson(inventoryRecord.npm_tarball) !==
      canonicalJson(manifest.npm.tarball) ||
    canonicalJson(inventoryRecord.files) !== canonicalJson(packageRows) ||
    canonicalJson(inventoryRecord.installed_package) !== canonicalJson(matrix)
  ) {
    fail('Package inventory record drifted from its referenced bytes.');
  }
  const declarationsRecord = assertArtifactRecord(
    verifyCanonicalRecord(
      root,
      manifest.live_validation.records.declarations!,
      'declarations record',
    ),
    'declarations',
    ['files', 'kind', 'npm_tarball', 'schema_version'],
  );
  if (
    canonicalJson(declarationsRecord.npm_tarball) !==
      canonicalJson(manifest.npm.tarball) ||
    canonicalJson(declarationsRecord.files) !== canonicalJson(declarations)
  ) {
    fail('Declarations record drifted from its referenced bytes.');
  }
  const seaRecord = assertArtifactRecord(
    verifyCanonicalRecord(
      root,
      manifest.live_validation.records.sea_manifest!,
      'SEA manifest record',
    ),
    'sea_manifest',
    ['kind', 'rows', 'schema_version'],
  );
  if (canonicalJson(seaRecord.rows) !== canonicalJson(manifest.sea.rows)) {
    fail('SEA manifest record drifted from its referenced bytes.');
  }
  const provenance = verifyCanonicalRecord(
    root,
    manifest.live_validation.records.provenance!,
    'provenance record',
  );
  if (
    manifest.provenance.path !==
      manifest.live_validation.records.provenance!.path ||
    manifest.provenance.sha256 !==
      manifest.live_validation.records.provenance!.sha256 ||
    canonicalJson(provenance) !==
      canonicalJson(provenanceStatement(manifest, manifest.sea.rows))
  ) {
    fail('Release provenance or attestation subject set drifted.');
  }
  const expectedFingerprint = liveAuthorityFingerprint(
    manifest,
    manifest.live_validation.artifact_hashes,
  );
  if (manifest.candidate.fingerprint !== expectedFingerprint) {
    fail('Release candidate live-validation authority fingerprint drifted.');
  }
  const expectedPaths = [
    CANDIDATE_MANIFEST,
    manifest.source_metadata.package_json.path,
    manifest.source_metadata.package_lock.path,
    manifest.npm.tarball.path,
    ...manifest.contracts_v1.files.map((row) => row.path),
    ...manifest.sea.rows.map((row) => row.path),
    ...RELEASE_CANDIDATE_RECORD_NAMES.map(
      (name) => manifest.live_validation.records[name]!.path,
    ),
  ].sort(compareText);
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    fail('Release candidate contains a missing or extra contract artifact.');
  }
  return manifest;
}

export function releaseCandidateArtifactArguments(
  manifest: CandidateManifest,
): readonly string[] {
  return RELEASE_CANDIDATE_RECORD_NAMES.flatMap((name) => [
    '--artifact',
    `${name}=${manifest.live_validation.records[name]!.path}`,
  ]);
}

export const releaseCandidateInternals = {
  assertPackagedInventoryShape,
  assertSeaBinary,
  canonicalJson,
  canonicalText,
  defaultLoadBuiltMatrix,
  defaultLoadInstalledMatrix,
  parseNpmTarball,
  sha256Bytes,
  sha256Hex,
};
