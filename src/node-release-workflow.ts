import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RC_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/;
const STABLE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_OUTPUT_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export class ReleaseCandidateWorkflowError extends Error {}

function fail(message: string): never {
  throw new ReleaseCandidateWorkflowError(message);
}

function git(repositoryRoot: string, arguments_: readonly string[]): string {
  try {
    return execFileSync('git', [...arguments_], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail(`Git authority check failed: git ${arguments_.join(' ')}`);
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function readJson(path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} must be valid JSON.`);
  }
  return jsonObject(value, label);
}

function safeDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(absolute);
  } catch {
    fail(`${label} does not exist.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a real directory.`);
  }
  return realpathSync(absolute);
}

function safeFile(path: string, label: string): string {
  const absolute = resolve(path);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(absolute);
  } catch {
    fail(`${label} does not exist.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a real regular file.`);
  }
  return realpathSync(absolute);
}

function sha256(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function lockVersion(lock: Record<string, unknown>): string {
  const packages = jsonObject(lock.packages, 'package-lock.json packages');
  const root = jsonObject(packages[''], 'package-lock.json root package');
  if (typeof lock.version !== 'string' || typeof root.version !== 'string') {
    fail('package-lock.json must contain top-level and root package versions.');
  }
  if (lock.version !== root.version) {
    fail('package-lock.json top-level and root package versions differ.');
  }
  return lock.version;
}

export interface ReleaseCandidateAuthority {
  readonly sha: string;
  readonly tree: string;
  readonly version: string;
  readonly release_kind: 'rc' | 'stable';
  readonly artifact_prefix: string;
}

export function assertReleaseCandidateAuthority(input: {
  readonly repository_root: string;
  readonly candidate_sha: string;
  readonly protected_ref: string;
  readonly release_kind: string;
  readonly dispatch_ref?: string;
  readonly dispatch_ref_protected?: string;
}): ReleaseCandidateAuthority {
  if (!FULL_SHA_PATTERN.test(input.candidate_sha)) {
    fail('Candidate SHA must be exactly 40 lowercase hexadecimal characters.');
  }
  if (
    input.dispatch_ref !== undefined &&
    input.dispatch_ref !== 'refs/heads/main'
  ) {
    fail('Release-candidate workflow must be dispatched from refs/heads/main.');
  }
  if (
    input.dispatch_ref_protected !== undefined &&
    input.dispatch_ref_protected !== 'true'
  ) {
    fail('Release-candidate workflow requires a protected main ref.');
  }

  const repositoryRoot = safeDirectory(
    input.repository_root,
    'Candidate repository',
  );
  if (
    git(repositoryRoot, ['cat-file', '-t', input.candidate_sha]) !== 'commit'
  ) {
    fail('Candidate SHA must identify a Git commit.');
  }
  const head = git(repositoryRoot, ['rev-parse', 'HEAD']);
  const protectedHead = git(repositoryRoot, ['rev-parse', input.protected_ref]);
  if (head !== input.candidate_sha || protectedHead !== input.candidate_sha) {
    fail('Candidate SHA, checked-out HEAD, and protected main tip must match.');
  }
  const status = git(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status !== '') {
    fail('Candidate repository must be exactly clean.');
  }

  const packageJson = readJson(
    join(repositoryRoot, 'package.json'),
    'package.json',
  );
  const packageLock = readJson(
    join(repositoryRoot, 'package-lock.json'),
    'package-lock.json',
  );
  if (packageJson.name !== 'librarium') {
    fail('Candidate package name must be librarium.');
  }
  if (typeof packageJson.version !== 'string') {
    fail('package.json version is missing.');
  }
  const version = packageJson.version;
  if (input.release_kind !== 'rc' && input.release_kind !== 'stable') {
    fail('Certification release kind must be explicitly rc or stable.');
  }
  if (
    (input.release_kind === 'rc' && !RC_VERSION_PATTERN.test(version)) ||
    (input.release_kind === 'stable' && !STABLE_VERSION_PATTERN.test(version))
  ) {
    fail(
      `Committed candidate version does not match explicit ${input.release_kind} certification mode.`,
    );
  }
  if (lockVersion(packageLock) !== version) {
    fail('Committed package and lock versions must match exactly.');
  }
  return {
    sha: head,
    tree: git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
    version,
    release_kind: input.release_kind,
    artifact_prefix: `librarium-rc-${head}`,
  };
}

const FORBIDDEN_WORKFLOW_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcontents:\s*write\b/i, 'write-level contents permission'],
  [/\bid-token:\s*write\b/i, 'OIDC write permission'],
  [/\bpackages:\s*write\b/i, 'package write permission'],
  [/\bnpm\s+publish\b/i, 'npm publication command'],
  [/\bnpm\s+version\b/i, 'package version mutation'],
  [/\bgh\s+release\b/i, 'GitHub release command'],
  [/\bgit\s+tag\b/i, 'Git tag command'],
  [/\bgit\s+push\b/i, 'Git push command'],
  [/\bbrew\s+tap(?!-new)\b/i, 'Homebrew tap command'],
  [/HOMEBREW_TAP_TOKEN/, 'Homebrew tap credential'],
  [/\b--clobber\b/, 'artifact clobber flag'],
  [/\b--force(?:-with-lease)?\b/, 'force flag'],
  [/\bcontinue-on-error\s*:\s*true\b/i, 'suppressed workflow failure'],
  [/\|\|\s*true\b/, 'suppressed command failure'],
  [/\boverwrite\s*:\s*true\b/i, 'overwritable workflow artifact'],
  [/\bsecrets\./, 'workflow secret reference'],
];

function uploadArtifactNames(source: string): string[] {
  const names: string[] = [];
  const blocks = source.split(/\n\s*- name:/);
  for (const block of blocks) {
    if (!/uses:\s*actions\/upload-artifact@[0-9a-f]{40}/.test(block)) continue;
    const name = /\n\s+name:\s*([^\n#]+)/.exec(block)?.[1]?.trim();
    if (!name) fail('Every artifact upload must have an explicit name.');
    names.push(name);
    if (!/\boverwrite:\s*false\b/.test(block)) {
      fail(`Artifact upload ${name} must set overwrite: false.`);
    }
    if (!name.includes('${{ needs.preflight.outputs.sha }}')) {
      fail(`Artifact upload ${name} must be qualified by the validated SHA.`);
    }
  }
  return names;
}

export function assertReleaseCandidateWorkflowPolicy(source: string): void {
  for (const [pattern, label] of FORBIDDEN_WORKFLOW_PATTERNS) {
    if (pattern.test(source)) fail(`RC workflow contains forbidden ${label}.`);
  }
  const actionUses = source.match(/^\s*uses:\s*actions\/[^\s#]+/gm) ?? [];
  if (actionUses.length === 0) {
    fail('RC workflow must use pinned GitHub Actions.');
  }
  for (const actionUse of actionUses) {
    if (!/@[0-9a-f]{40}$/.test(actionUse.trim())) {
      fail('Every GitHub Action must be pinned to a full commit SHA.');
    }
  }
  const required = [
    'workflow_dispatch:',
    'git_sha:',
    'release_kind:',
    'permissions:\n  contents: read',
    'github.ref_protected',
    'Validate dispatch context before candidate code',
    'Validate Git authority before candidate code',
    'Reject source mutation',
    'refs/remotes/origin/main',
    'npm run rc:package --',
    'npm run rc:verify-package --',
    'node-version: [22.12.0, 24, 26]',
    'node-version: 22.11.0',
    'librarium-linux-x64',
    'librarium-linux-arm64',
    'librarium-macos-x64',
    'librarium-macos-arm64',
    'librarium-windows-x64.exe',
    'npm run rc:assemble --',
    'npm run rc:verify --',
    'tests/install-script.test.ts',
    'tests/commands/upgrade.test.ts',
    'scripts/rc-distribution-proof.mjs',
  ];
  for (const fragment of required) {
    if (!source.includes(fragment)) {
      fail(`RC workflow is missing required policy fragment: ${fragment}`);
    }
  }
  if (/\n\s+version:\s*\n\s+description:/.test(source)) {
    fail('RC workflow must not accept a mutable version input.');
  }
  if (
    !/release_kind:\s*\n\s+description:[^\n]*\n\s+required: true\s*\n\s+type: choice\s*\n\s+options:\s*\n\s+- rc\s*\n\s+- stable/.test(
      source,
    ) ||
    /release_kind:\s*[\s\S]{0,240}\n\s+default:/.test(source)
  ) {
    fail(
      'Certification mode must be an explicit default-free rc/stable choice.',
    );
  }
  const rawInputUses = source.match(/\$\{\{\s*inputs\.git_sha\s*\}\}/g) ?? [];
  if (rawInputUses.length !== 1) {
    fail(
      'Raw candidate SHA input must cross the workflow boundary exactly once.',
    );
  }
  const uploadNames = uploadArtifactNames(source);
  if (uploadNames.length < 3) {
    fail('RC workflow must upload package, SEA, and final proof artifacts.');
  }
  if (new Set(uploadNames).size !== uploadNames.length) {
    fail('RC workflow contains duplicate artifact output names.');
  }
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

export function frozenPackageInput(packageRootInput: string): {
  readonly tarball: string;
  readonly sha256: string;
} {
  const packageRoot = safeDirectory(packageRootInput, 'Frozen package root');
  const manifest = readJson(
    join(packageRoot, 'frozen-package.json'),
    'Frozen package manifest',
  );
  const npm = jsonObject(manifest.npm, 'Frozen package npm metadata');
  const tarball = jsonObject(npm.tarball, 'Frozen package tarball reference');
  if (typeof tarball.path !== 'string' || typeof tarball.sha256 !== 'string') {
    fail('Frozen package tarball reference is incomplete.');
  }
  if (!SHA256_PATTERN.test(tarball.sha256)) {
    fail('Frozen package tarball SHA-256 is invalid.');
  }
  const path = safeFile(
    join(packageRoot, ...tarball.path.split('/')),
    'Frozen npm tarball',
  );
  if (!contained(packageRoot, path) || sha256(path) !== tarball.sha256) {
    fail('Frozen npm tarball bytes drifted.');
  }
  return { tarball: path, sha256: tarball.sha256.slice(7) };
}

function githubOutput(values: Readonly<Record<string, string>>): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) fail('GITHUB_OUTPUT is required for --github-output.');
  for (const [name, value] of Object.entries(values)) {
    if (!SAFE_OUTPUT_PATTERN.test(name) || /[\r\n]/.test(value)) {
      fail('GitHub output name or value is unsafe.');
    }
    appendFileSync(output, `${name}=${value}\n`, { encoding: 'utf8' });
  }
}

function option(name: string, required = true): string | undefined {
  const flag = `--${name}`;
  const indexes = process.argv.flatMap((value, index) =>
    value === flag ? [index] : [],
  );
  if (indexes.length > 1) fail(`Duplicate option: ${flag}`);
  const index = indexes[0];
  const value = index === undefined ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith('--'))) {
    fail(`Missing option: ${flag}`);
  }
  return value;
}

export async function runReleaseCandidateWorkflowCli(): Promise<void> {
  const command = process.argv[2];
  if (command === 'policy') {
    const workflow = safeFile(option('workflow')!, 'RC workflow');
    assertReleaseCandidateWorkflowPolicy(readFileSync(workflow, 'utf8'));
    process.stdout.write(
      `${JSON.stringify({ policy: 'verified', workflow: basename(workflow) })}\n`,
    );
    return;
  }
  if (command === 'preflight') {
    const authority = assertReleaseCandidateAuthority({
      repository_root: option('repository')!,
      candidate_sha: option('candidate-sha')!,
      protected_ref: option('protected-ref')!,
      release_kind: option('release-kind')!,
      dispatch_ref: process.env.GITHUB_REF,
      dispatch_ref_protected: process.env.GITHUB_REF_PROTECTED,
    });
    if (process.argv.includes('--github-output')) {
      githubOutput({
        sha: authority.sha,
        tree: authority.tree,
        version: authority.version,
        release_kind: authority.release_kind,
        artifact_prefix: authority.artifact_prefix,
      });
    }
    process.stdout.write(`${JSON.stringify(authority)}\n`);
    return;
  }
  if (command === 'package-input') {
    const input = frozenPackageInput(option('package')!);
    if (process.argv.includes('--github-output')) githubOutput(input);
    process.stdout.write(`${JSON.stringify(input)}\n`);
    return;
  }
  fail('Usage: rc-workflow <policy|preflight|package-input> [options]');
}
