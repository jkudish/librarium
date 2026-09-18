import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  RELEASE_CANDIDATE_SEA_TARGETS,
  type ReleaseCandidateDependencies,
  verifyReleaseCandidate,
} from './node-release-candidate.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/;

export type ReleaseKind = 'rc' | 'stable';
export type ReleasePromotionMode = 'new' | 'recover';

export class ReleasePromotionError extends Error {}

function fail(message: string): never {
  throw new ReleasePromotionError(message);
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} fields are invalid.`);
  }
}

function string(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string | null {
  return value === null ? null : string(value, label, pattern);
}

function stringMap(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const record = object(value, label);
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(record)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
      fail(`${label} contains an invalid artifact name.`);
    }
    result[key] = string(child, `${label} ${key}`, SHA256_PATTERN);
  }
  return result;
}

function versionMap(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const record = object(value, label);
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(record)) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(key)) {
      fail(`${label} contains an invalid dist-tag name.`);
    }
    result[key] = string(child, `${label} ${key}`);
  }
  return result;
}

function releaseKind(version: string): ReleaseKind {
  if (!VERSION_PATTERN.test(version)) fail('Candidate version is invalid.');
  return version.includes('-rc.') ? 'rc' : 'stable';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    fail('Promotion metadata is not JSON serializable.');
  return encoded;
}

function canonicalText(value: unknown): string {
  return `${canonical(value)}\n`;
}

function safeOutput(path: string): string {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
    fail('Promotion output must not already exist.');
  } catch (error) {
    if (error instanceof ReleasePromotionError) throw error;
  }
  mkdirSync(absolute, { recursive: false, mode: 0o755 });
  return realpathSync(absolute);
}

export interface ReleasePromotionSpec {
  readonly schema_version: 1;
  readonly contract: 'librarium-release-promotion';
  readonly repository: 'jkudish/librarium';
  readonly candidate: {
    readonly git_sha: string;
    readonly git_tree: string;
    readonly version: string;
    readonly fingerprint: string;
    readonly release_kind: ReleaseKind;
  };
  readonly tag: string;
  readonly npm: {
    readonly asset: string;
    readonly sha256: string;
    readonly dist_tag: 'rc' | 'latest';
  };
  readonly github_assets: Readonly<Record<string, string>>;
  readonly checksum_manifest: 'SHA256SUMS';
  readonly homebrew_formula: {
    readonly path: 'Formula/librarium.rb';
    readonly sha256: string;
  };
}

function renderChecksums(input: {
  readonly sha: string;
  readonly fingerprint: string;
  readonly version: string;
  readonly assets: Readonly<Record<string, string>>;
}): string {
  const rows = Object.entries(input.assets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest.slice(7)}  ${name}`);
  return [
    `# librarium-candidate-sha ${input.sha}`,
    `# librarium-candidate-fingerprint ${input.fingerprint}`,
    `# librarium-version ${input.version}`,
    ...rows,
    '',
  ].join('\n');
}

function renderHomebrewFormula(input: {
  readonly version: string;
  readonly sha: string;
  readonly fingerprint: string;
  readonly sea: Readonly<Record<string, string>>;
}): string {
  const digest = (name: string): string => {
    const value = input.sea[name];
    if (!value) fail(`Missing Homebrew SEA input ${name}.`);
    return value.slice(7);
  };
  return `# candidate-sha: ${input.sha}
# candidate-fingerprint: ${input.fingerprint}
class Librarium < Formula
  desc "Evidence-aware multi-provider research"
  homepage "https://librarium.agentsy.build"
  version "${input.version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/jkudish/librarium/releases/download/v${input.version}/librarium-macos-arm64"
      sha256 "${digest('librarium-macos-arm64')}"
    else
      url "https://github.com/jkudish/librarium/releases/download/v${input.version}/librarium-macos-x64"
      sha256 "${digest('librarium-macos-x64')}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/jkudish/librarium/releases/download/v${input.version}/librarium-linux-arm64"
      sha256 "${digest('librarium-linux-arm64')}"
    else
      url "https://github.com/jkudish/librarium/releases/download/v${input.version}/librarium-linux-x64"
      sha256 "${digest('librarium-linux-x64')}"
    end
  end

  def install
    bin.install Dir["librarium-*"].first => "librarium"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/librarium --version")
  end
end
`;
}

export async function prepareReleasePromotion(input: {
  readonly repository_root: string;
  readonly candidate_root: string;
  readonly output_root: string;
  readonly dependencies?: ReleaseCandidateDependencies;
}): Promise<ReleasePromotionSpec> {
  const manifest = await verifyReleaseCandidate({
    repository_root: input.repository_root,
    candidate_root: input.candidate_root,
    dependencies: input.dependencies,
  });
  const output = safeOutput(input.output_root);
  const assetSources = new Map<string, string>();
  assetSources.set(
    basename(manifest.npm.tarball.path),
    manifest.npm.tarball.path,
  );
  for (const row of manifest.sea.rows) assetSources.set(row.name, row.path);
  assetSources.set('candidate.json', 'candidate.json');
  assetSources.set('provenance.json', manifest.provenance.path);

  const assetHashes: Record<string, string> = {};
  for (const [name, source] of assetSources) {
    const bytes = readFileSync(
      join(input.candidate_root, ...source.split('/')),
    );
    const digest = sha256(bytes);
    copyFileSync(
      join(input.candidate_root, ...source.split('/')),
      join(output, name),
    );
    assetHashes[name] = digest;
  }
  if (
    assetHashes[basename(manifest.npm.tarball.path)] !==
    manifest.npm.tarball.sha256
  ) {
    fail('Staged npm bytes differ from the verified candidate.');
  }
  for (const row of manifest.sea.rows) {
    if (assetHashes[row.name] !== row.sha256) {
      fail(`Staged SEA bytes differ for ${row.name}.`);
    }
  }

  const checksums = renderChecksums({
    sha: manifest.candidate.git_sha,
    fingerprint: manifest.candidate.fingerprint,
    version: manifest.candidate.version,
    assets: assetHashes,
  });
  writeFileSync(join(output, 'SHA256SUMS'), checksums, { mode: 0o644 });
  const githubAssets = {
    ...assetHashes,
    SHA256SUMS: sha256(checksums),
  };
  const sea = Object.fromEntries(
    RELEASE_CANDIDATE_SEA_TARGETS.map(({ name }) => [name, assetHashes[name]!]),
  );
  const formula = renderHomebrewFormula({
    version: manifest.candidate.version,
    sha: manifest.candidate.git_sha,
    fingerprint: manifest.candidate.fingerprint,
    sea,
  });
  writeFileSync(join(output, 'librarium.rb'), formula, { mode: 0o644 });
  const spec: ReleasePromotionSpec = {
    schema_version: 1,
    contract: 'librarium-release-promotion',
    repository: 'jkudish/librarium',
    candidate: {
      git_sha: manifest.candidate.git_sha,
      git_tree: manifest.candidate.git_tree,
      version: manifest.candidate.version,
      fingerprint: manifest.candidate.fingerprint,
      release_kind: releaseKind(manifest.candidate.version),
    },
    tag: `v${manifest.candidate.version}`,
    npm: {
      asset: basename(manifest.npm.tarball.path),
      sha256: manifest.npm.tarball.sha256,
      dist_tag:
        releaseKind(manifest.candidate.version) === 'rc' ? 'rc' : 'latest',
    },
    github_assets: githubAssets,
    checksum_manifest: 'SHA256SUMS',
    homebrew_formula: {
      path: 'Formula/librarium.rb',
      sha256: sha256(formula),
    },
  };
  writeFileSync(join(output, 'promotion.json'), canonicalText(spec), {
    mode: 0o644,
  });
  return spec;
}

export interface ReleasePromotionInventory {
  readonly branch_sha: string;
  readonly tag_sha: string | null;
  readonly npm_sha256: string | null;
  readonly npm_dist_tags: Readonly<Record<string, string>>;
  readonly github_release: null | {
    readonly target_sha: string;
    readonly assets: Readonly<Record<string, string>>;
  };
  readonly homebrew_version: string | null;
  readonly homebrew_formula_sha256: string | null;
}

export interface ReleasePromotionPlan {
  readonly complete: boolean;
  readonly publish_npm: boolean;
  readonly set_npm_dist_tag: boolean;
  readonly create_tag: boolean;
  readonly create_github_release: boolean;
  readonly upload_github_assets: readonly string[];
  readonly publish_homebrew: boolean;
}

export function parseReleasePromotionSpec(
  value: unknown,
): ReleasePromotionSpec {
  const root = object(value, 'Promotion specification');
  exactKeys(
    root,
    [
      'candidate',
      'checksum_manifest',
      'contract',
      'github_assets',
      'homebrew_formula',
      'npm',
      'repository',
      'schema_version',
      'tag',
    ],
    'Promotion specification',
  );
  if (
    root.schema_version !== 1 ||
    root.contract !== 'librarium-release-promotion' ||
    root.repository !== 'jkudish/librarium' ||
    root.checksum_manifest !== 'SHA256SUMS'
  ) {
    fail('Promotion specification contract is invalid.');
  }
  const candidate = object(root.candidate, 'Promotion candidate');
  exactKeys(
    candidate,
    ['fingerprint', 'git_sha', 'git_tree', 'release_kind', 'version'],
    'Promotion candidate',
  );
  const npm = object(root.npm, 'Promotion npm');
  exactKeys(npm, ['asset', 'dist_tag', 'sha256'], 'Promotion npm');
  const formula = object(root.homebrew_formula, 'Promotion Homebrew formula');
  exactKeys(formula, ['path', 'sha256'], 'Promotion Homebrew formula');
  const parsed = {
    ...root,
    candidate: {
      git_sha: string(candidate.git_sha, 'Candidate SHA', SHA_PATTERN),
      git_tree: string(candidate.git_tree, 'Candidate tree', SHA_PATTERN),
      version: string(candidate.version, 'Candidate version', VERSION_PATTERN),
      fingerprint: string(
        candidate.fingerprint,
        'Candidate fingerprint',
        SHA256_PATTERN,
      ),
      release_kind: string(
        candidate.release_kind,
        'Candidate release kind',
      ) as ReleaseKind,
    },
    npm: {
      asset: string(npm.asset, 'npm asset'),
      sha256: string(npm.sha256, 'npm SHA-256', SHA256_PATTERN),
      dist_tag: string(npm.dist_tag, 'npm dist-tag') as 'rc' | 'latest',
    },
    github_assets: stringMap(root.github_assets, 'GitHub assets'),
    homebrew_formula: {
      path: string(formula.path, 'Homebrew formula path'),
      sha256: string(
        formula.sha256,
        'Homebrew formula SHA-256',
        SHA256_PATTERN,
      ),
    },
  } as ReleasePromotionSpec;
  if (parsed.tag !== `v${parsed.candidate.version}`) {
    fail('Promotion tag differs from the exact candidate version.');
  }
  const expectedKind = releaseKind(parsed.candidate.version);
  if (
    parsed.candidate.release_kind !== expectedKind ||
    parsed.npm.dist_tag !== (expectedKind === 'rc' ? 'rc' : 'latest')
  ) {
    fail(
      'Promotion release kind or npm dist-tag differs from candidate identity.',
    );
  }
  if (
    parsed.homebrew_formula.path !== 'Formula/librarium.rb' ||
    parsed.npm.asset !== `librarium-${parsed.candidate.version}.tgz` ||
    parsed.github_assets[parsed.npm.asset] !== parsed.npm.sha256
  ) {
    fail('Promotion distribution identity is inconsistent.');
  }
  return parsed;
}

export function parseReleasePromotionInventory(
  value: unknown,
): ReleasePromotionInventory {
  const root = object(value, 'Promotion inventory');
  exactKeys(
    root,
    [
      'branch_sha',
      'github_release',
      'homebrew_formula_sha256',
      'homebrew_version',
      'npm_dist_tags',
      'npm_sha256',
      'tag_sha',
    ],
    'Promotion inventory',
  );
  let githubRelease: ReleasePromotionInventory['github_release'] = null;
  if (root.github_release !== null) {
    const release = object(root.github_release, 'GitHub release inventory');
    exactKeys(release, ['assets', 'target_sha'], 'GitHub release inventory');
    githubRelease = {
      target_sha: string(
        release.target_sha,
        'GitHub release target',
        SHA_PATTERN,
      ),
      assets: stringMap(release.assets, 'GitHub release assets'),
    };
  }
  return {
    branch_sha: string(root.branch_sha, 'Branch SHA', SHA_PATTERN),
    tag_sha: optionalString(root.tag_sha, 'Tag SHA', SHA_PATTERN),
    npm_sha256: optionalString(root.npm_sha256, 'npm SHA-256', SHA256_PATTERN),
    npm_dist_tags: versionMap(root.npm_dist_tags, 'npm dist-tags'),
    github_release: githubRelease,
    homebrew_version: optionalString(root.homebrew_version, 'Homebrew version'),
    homebrew_formula_sha256: optionalString(
      root.homebrew_formula_sha256,
      'Homebrew formula SHA-256',
      SHA256_PATTERN,
    ),
  };
}

function versionOrder(version: string): readonly number[] {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(
      version,
    );
  if (!match) fail('Homebrew version is not a supported exact version.');
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4]),
  ];
}

function earlierVersion(left: string, right: string): boolean {
  const leftOrder = versionOrder(left);
  const rightOrder = versionOrder(right);
  for (let index = 0; index < leftOrder.length; index += 1) {
    if (leftOrder[index] !== rightOrder[index]) {
      return leftOrder[index]! < rightOrder[index]!;
    }
  }
  return false;
}

export function reconcileReleasePromotion(
  spec: ReleasePromotionSpec,
  inventory: ReleasePromotionInventory,
  mode: ReleasePromotionMode,
): ReleasePromotionPlan {
  if (mode !== 'new' && mode !== 'recover') {
    fail('Promotion mode must be explicitly new or recover.');
  }
  if (mode === 'new' && inventory.branch_sha !== spec.candidate.git_sha) {
    fail('Protected main no longer identifies the certified candidate.');
  }
  if (
    inventory.npm_sha256 !== null &&
    inventory.npm_sha256 !== spec.npm.sha256
  ) {
    fail('npm contains conflicting bytes for the candidate version.');
  }
  const npmBytesComplete = inventory.npm_sha256 !== null;
  if (mode === 'recover' && !npmBytesComplete) {
    fail('Recovery requires exact candidate bytes to exist on npm already.');
  }
  const expectedDistTag = spec.npm.dist_tag;
  const actualDistTag = inventory.npm_dist_tags[expectedDistTag];
  if (
    actualDistTag !== undefined &&
    actualDistTag !== spec.candidate.version &&
    !earlierVersion(actualDistTag, spec.candidate.version)
  ) {
    fail(`npm dist-tag ${expectedDistTag} points to a newer version.`);
  }
  if (
    spec.candidate.release_kind === 'rc' &&
    inventory.npm_dist_tags.latest === spec.candidate.version
  ) {
    fail('RC candidate must never own the npm latest dist-tag.');
  }
  if (!npmBytesComplete && actualDistTag === spec.candidate.version) {
    fail('npm dist-tag identifies candidate bytes that are absent.');
  }
  if (
    inventory.tag_sha !== null &&
    inventory.tag_sha !== spec.candidate.git_sha
  ) {
    fail('Git tag conflicts with the certified candidate SHA.');
  }
  if (
    inventory.github_release !== null &&
    inventory.github_release.target_sha !== spec.candidate.git_sha
  ) {
    fail('GitHub release targets a conflicting candidate SHA.');
  }
  const missingAssets: string[] = [];
  if (inventory.github_release) {
    for (const [name, actual] of Object.entries(
      inventory.github_release.assets,
    )) {
      const expected = spec.github_assets[name];
      if (!expected) fail(`GitHub release contains unexpected asset ${name}.`);
      if (actual !== expected) fail(`GitHub release asset ${name} conflicts.`);
    }
    for (const name of Object.keys(spec.github_assets).sort()) {
      if (!(name in inventory.github_release.assets)) missingAssets.push(name);
    }
  }
  if (
    inventory.homebrew_formula_sha256 !== null &&
    inventory.homebrew_formula_sha256 !== spec.homebrew_formula.sha256
  ) {
    fail('Homebrew formula conflicts with the certified candidate.');
  }
  if (
    inventory.homebrew_version !== null &&
    inventory.homebrew_version !== spec.candidate.version &&
    !earlierVersion(inventory.homebrew_version, spec.candidate.version)
  ) {
    fail('Homebrew formula is newer than the certified candidate.');
  }
  if (
    (inventory.homebrew_version === spec.candidate.version) !==
    (inventory.homebrew_formula_sha256 !== null)
  ) {
    fail('Homebrew version and formula identity are inconsistent.');
  }

  const npmTagComplete = actualDistTag === spec.candidate.version;
  const npmComplete = npmBytesComplete && npmTagComplete;
  const tagComplete = inventory.tag_sha !== null;
  const releaseExists = inventory.github_release !== null;
  const releaseComplete = releaseExists && missingAssets.length === 0;
  const homebrewComplete = inventory.homebrew_formula_sha256 !== null;
  if (tagComplete && !npmComplete) {
    fail(
      'Remote state is not forward-only: tag exists before npm publication.',
    );
  }
  if (releaseExists && !tagComplete) {
    fail('Remote state is not forward-only: GitHub release exists before tag.');
  }
  if (homebrewComplete && !releaseComplete) {
    fail(
      'Remote state is not forward-only: Homebrew exists before release assets.',
    );
  }

  return {
    complete: npmComplete && tagComplete && releaseComplete && homebrewComplete,
    publish_npm: !npmBytesComplete,
    set_npm_dist_tag: npmBytesComplete && !npmTagComplete,
    create_tag: npmComplete && !tagComplete,
    create_github_release: tagComplete && !releaseExists,
    upload_github_assets: releaseExists ? missingAssets : [],
    publish_homebrew: releaseComplete && !homebrewComplete,
  };
}

export function verifyPromotionStaging(
  rootInput: string,
): ReleasePromotionSpec {
  const root = realpathSync(resolve(rootInput));
  const spec = parseReleasePromotionSpec(
    JSON.parse(readFileSync(join(root, 'promotion.json'), 'utf8')),
  );
  for (const [name, expected] of Object.entries(spec.github_assets)) {
    const path = join(root, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(`Promotion asset ${name} is not a regular file.`);
    }
    if (sha256(readFileSync(path)) !== expected) {
      fail(`Promotion asset ${name} drifted.`);
    }
  }
  if (
    sha256(readFileSync(join(root, 'librarium.rb'))) !==
    spec.homebrew_formula.sha256
  ) {
    fail('Homebrew formula drifted.');
  }
  return spec;
}
