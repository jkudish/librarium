import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  releaseCandidateInternals,
  verifyReleaseCandidate,
} from './node-release-candidate.js';

type FormulaPlatform = 'linux' | 'darwin';
type FormulaArch = 'x64' | 'arm64';

interface HomebrewInput {
  readonly platform: FormulaPlatform;
  readonly arch: FormulaArch;
  readonly name: string;
  readonly sha256: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function outputDirectory(path: string): string {
  const absolute = resolve(path);
  const existing = lstatSync(absolute, { throwIfNoEntry: false });
  if (existing) fail('Distribution proof refuses to clobber its output.');
  const parent = realpathSync(resolve(absolute, '..'));
  if (!lstatSync(parent).isDirectory()) fail('Proof output parent is invalid.');
  mkdirSync(absolute, { mode: 0o755 });
  return absolute;
}

export function homebrewInputFor(
  rows: readonly HomebrewInput[],
  platform_: FormulaPlatform,
  arch_: FormulaArch,
): HomebrewInput {
  const matches = rows.filter(
    (row) => row.platform === platform_ && row.arch === arch_,
  );
  if (matches.length !== 1) {
    fail(
      `Homebrew ${platform_}/${arch_} must resolve to exactly one SEA input.`,
    );
  }
  return matches[0]!;
}

function rubyString(value: string): string {
  return JSON.stringify(value);
}

export function renderLocalHomebrewFormula(input: {
  readonly version: string;
  readonly rows: readonly HomebrewInput[];
}): string {
  const macArm = homebrewInputFor(input.rows, 'darwin', 'arm64');
  const macX64 = homebrewInputFor(input.rows, 'darwin', 'x64');
  const linuxArm = homebrewInputFor(input.rows, 'linux', 'arm64');
  const linuxX64 = homebrewInputFor(input.rows, 'linux', 'x64');
  const branch = (row: HomebrewInput, indentation: string) =>
    `${indentation}url ${rubyString(`file:///candidate/sea/${row.name}`)}\n` +
    `${indentation}sha256 ${rubyString(row.sha256.slice(7))}\n`;
  return (
    `class LibrariumRcProof < Formula\n` +
    `  desc "Local immutable Librarium release-candidate proof"\n` +
    `  homepage "https://github.com/jkudish/librarium"\n` +
    `  version ${rubyString(input.version)}\n` +
    `  license "MIT"\n\n` +
    `  on_macos do\n` +
    `    if Hardware::CPU.arm?\n` +
    branch(macArm, '      ') +
    `    else\n` +
    branch(macX64, '      ') +
    `    end\n` +
    `  end\n\n` +
    `  on_linux do\n` +
    `    if Hardware::CPU.arm?\n` +
    branch(linuxArm, '      ') +
    `    else\n` +
    branch(linuxX64, '      ') +
    `    end\n` +
    `  end\n\n` +
    `  def install\n` +
    `    bin.install Dir["librarium-*"].first => "librarium"\n` +
    `  end\n\n` +
    `  test do\n` +
    `    assert_match version.to_s, shell_output("#{bin}/librarium --version")\n` +
    `  end\n` +
    `end\n`
  );
}

function run(
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly capture?: boolean;
  },
): string {
  return execFileSync(executable, [...arguments_], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture
      ? ['ignore', 'pipe', 'pipe']
      : ['ignore', 'inherit', 'inherit'],
  }) as string;
}

function currentSeaName(): string {
  const currentPlatform = platform();
  const currentArch = arch();
  if (currentPlatform === 'linux' && ['x64', 'arm64'].includes(currentArch)) {
    return `librarium-linux-${currentArch}`;
  }
  if (currentPlatform === 'darwin' && ['x64', 'arm64'].includes(currentArch)) {
    return `librarium-macos-${currentArch}`;
  }
  fail(
    `Local installer proof is unsupported on ${currentPlatform}/${currentArch}.`,
  );
}

function priorBinary(version: string): string {
  return `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' ${JSON.stringify(
    version,
  )}; else exit 0; fi\n`;
}

export async function createReleaseCandidateDistributionProof(input: {
  readonly repository_root: string;
  readonly candidate_root: string;
  readonly output_root: string;
}): Promise<Record<string, unknown>> {
  const manifest = await verifyReleaseCandidate({
    repository_root: input.repository_root,
    candidate_root: input.candidate_root,
  });
  const output = outputDirectory(input.output_root);
  const workspace = mkdtempSync(join(tmpdir(), 'librarium-rc-proof-'));
  try {
    const tarball = join(
      input.candidate_root,
      ...manifest.npm.tarball.path.split('/'),
    );
    const tarballSha = sha256(tarball);
    if (`sha256:${tarballSha}` !== manifest.npm.tarball.sha256) {
      fail('Distribution proof npm tarball drifted before installation.');
    }

    const npmPrefix = join(workspace, 'npm-prefix');
    mkdirSync(npmPrefix);
    run(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'install',
        '--global',
        '--prefix',
        npmPrefix,
        '--engine-strict',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        tarball,
      ],
      { cwd: workspace },
    );
    const npmCli = join(
      npmPrefix,
      'bin',
      process.platform === 'win32' ? 'librarium.cmd' : 'librarium',
    );
    const npmVersion = run(npmCli, ['--version'], {
      cwd: workspace,
      capture: true,
    }).trim();
    if (npmVersion !== manifest.candidate.version) {
      fail('Exact local npm install returned the wrong version.');
    }
    run(npmCli, ['--help'], { cwd: workspace, capture: true });
    const upgradeDryRun = run(
      npmCli,
      ['upgrade', '--dry-run', '--target', manifest.candidate.version],
      { cwd: workspace, capture: true },
    );
    if (
      !upgradeDryRun.includes('Would upgrade librarium') ||
      !upgradeDryRun.includes(`librarium@${manifest.candidate.version}`)
    ) {
      fail('Exact offline upgrade target dry-run was not exercised.');
    }

    const seaName = currentSeaName();
    const seaRow = manifest.sea.rows.find((row) => row.name === seaName);
    if (!seaRow) fail(`Candidate is missing local SEA input ${seaName}.`);
    const seaPath = join(input.candidate_root, ...seaRow.path.split('/'));
    const installRoot = join(workspace, 'standalone-bin');
    mkdirSync(installRoot);
    const destination = join(installRoot, 'librarium');
    const priorVersion = '0.0.0-rc.1';
    writeFileSync(destination, priorBinary(priorVersion), { mode: 0o755 });
    const priorBytes = readFileSync(destination);
    const priorSha = sha256(destination);
    run('sh', [join(input.repository_root, 'scripts/install.sh')], {
      cwd: workspace,
      env: {
        ...process.env,
        LIBRARIUM_CANDIDATE: seaPath,
        LIBRARIUM_SHA256: seaRow.sha256.slice(7),
        LIBRARIUM_VERSION: manifest.candidate.version,
        LIBRARIUM_INSTALL_DIR: installRoot,
      },
    });
    const installedSha = sha256(destination);
    const installedVersion = run(destination, ['--version'], {
      cwd: workspace,
      capture: true,
    }).trim();
    if (
      installedSha !== seaRow.sha256.slice(7) ||
      installedVersion !== manifest.candidate.version
    ) {
      fail(
        'Exact local standalone install did not preserve candidate identity.',
      );
    }
    writeFileSync(destination, priorBytes, { mode: 0o755 });
    chmodSync(destination, 0o755);
    if (sha256(destination) !== priorSha) {
      fail('Distribution proof failed to restore the prior local install.');
    }

    const homebrewRows: HomebrewInput[] = manifest.sea.rows
      .filter(
        (
          row,
        ): row is typeof row & {
          platform: FormulaPlatform;
          arch: FormulaArch;
        } => row.platform !== 'win32',
      )
      .map((row) => ({
        platform: row.platform,
        arch: row.arch,
        name: row.name,
        sha256: row.sha256,
      }));
    for (const platform_ of ['darwin', 'linux'] as const) {
      for (const arch_ of ['arm64', 'x64'] as const) {
        homebrewInputFor(homebrewRows, platform_, arch_);
      }
    }
    const formula = renderLocalHomebrewFormula({
      version: manifest.candidate.version,
      rows: homebrewRows,
    });
    const formulaPath = join(output, 'librarium-rc-proof.rb');
    writeFileSync(formulaPath, formula, { flag: 'wx', mode: 0o644 });
    run('ruby', ['-c', formulaPath], { cwd: workspace, capture: true });

    await verifyReleaseCandidate({
      repository_root: input.repository_root,
      candidate_root: input.candidate_root,
    });
    if (sha256(tarball) !== tarballSha) {
      fail('Distribution proof mutated the exact npm tarball.');
    }

    const proof = {
      schema_version: 1,
      kind: 'local_distribution_proof',
      candidate: {
        git_sha: manifest.candidate.git_sha,
        git_tree: manifest.candidate.git_tree,
        version: manifest.candidate.version,
        fingerprint: manifest.candidate.fingerprint,
      },
      npm: {
        tarball: manifest.npm.tarball.path,
        sha256: manifest.npm.tarball.sha256,
        installed_version: npmVersion,
      },
      standalone: {
        artifact: seaRow.path,
        sha256: seaRow.sha256,
        installed_version: installedVersion,
        prior_install_sha256: `sha256:${priorSha}`,
        prior_install_restored: true,
      },
      upgrade: {
        explicit_target: manifest.candidate.version,
        latest_fetch_used: false,
        dry_run: true,
      },
      homebrew: {
        formula: 'librarium-rc-proof.rb',
        syntax_verified: true,
        selections: homebrewRows,
      },
      publication_side_effects: [],
    };
    writeFileSync(
      join(output, 'proof.json'),
      releaseCandidateInternals.canonicalText(proof),
      { flag: 'wx', mode: 0o644 },
    );
    return proof;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function option(name: string): string {
  const flag = `--${name}`;
  const indexes = process.argv.flatMap((value, index) =>
    value === flag ? [index] : [],
  );
  if (indexes.length !== 1) fail(`Expected exactly one ${flag} option.`);
  const value = process.argv[indexes[0]! + 1];
  if (!value || value.startsWith('--')) fail(`Missing value for ${flag}.`);
  return resolve(value);
}

export async function runReleaseCandidateDistributionProofCli(): Promise<void> {
  const proof = await createReleaseCandidateDistributionProof({
    repository_root: option('repository'),
    candidate_root: option('candidate'),
    output_root: option('output'),
  });
  process.stdout.write(`${JSON.stringify(proof.candidate)}\n`);
}
