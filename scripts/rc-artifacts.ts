import { resolve } from 'node:path';
import {
  assembleReleaseCandidate,
  buildFrozenReleasePackage,
  releaseCandidateArtifactArguments,
  verifyFrozenReleasePackage,
  verifyReleaseCandidate,
} from '../src/node-release-candidate.js';

function usage(): never {
  throw new Error(
    'Usage: rc-artifacts <package|verify-package|assemble|verify> --repository <clean-checkout> [--output <new-dir> | --package <frozen-package-dir> --sea <five-binary-dir> | --candidate <candidate-dir>]',
  );
}

function option(name: string, required = true): string | undefined {
  const flag = `--${name}`;
  const indexes = process.argv.flatMap((value, index) =>
    value === flag ? [index] : [],
  );
  if (indexes.length > 1) throw new Error(`Duplicate option: ${flag}`);
  const index = indexes[0];
  const value = index === undefined ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith('--'))) usage();
  return value;
}

function localPath(name: string): string {
  const value = option(name);
  const windowsDriveAbsolute = /^[A-Za-z]:[\\/]/.test(value ?? '');
  if (
    !value ||
    (!windowsDriveAbsolute && /^(?:[a-z][a-z0-9+.-]*:|\\\\)/i.test(value))
  ) {
    throw new Error(`--${name} must be a local filesystem path.`);
  }
  return resolve(value);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'package') {
    const manifest = await buildFrozenReleasePackage({
      repository_root: localPath('repository'),
      output_root: localPath('output'),
    });
    process.stdout.write(
      `${JSON.stringify({
        git_sha: manifest.candidate.git_sha,
        git_tree: manifest.candidate.git_tree,
        version: manifest.candidate.version,
        tarball: manifest.npm.tarball,
        declarations: manifest.npm.declarations.length,
        package_files: manifest.npm.inventory.length,
        contracts_fingerprint: manifest.contracts_v1.fingerprint,
        matrix_fingerprint: manifest.installed_package.matrix_fingerprint,
      })}\n`,
    );
    return;
  }
  if (command === 'assemble') {
    const manifest = await assembleReleaseCandidate({
      repository_root: localPath('repository'),
      package_root: localPath('package'),
      sea_root: localPath('sea'),
      output_root: localPath('output'),
    });
    process.stdout.write(
      `${JSON.stringify({
        candidate_fingerprint: manifest.candidate.fingerprint,
        git_sha: manifest.candidate.git_sha,
        version: manifest.candidate.version,
        artifact_arguments: releaseCandidateArtifactArguments(manifest),
      })}\n`,
    );
    return;
  }
  if (command === 'verify-package') {
    const { manifest } = await verifyFrozenReleasePackage(
      localPath('package'),
      localPath('repository'),
      {},
    );
    process.stdout.write(
      `${JSON.stringify({
        verified: true,
        git_sha: manifest.candidate.git_sha,
        git_tree: manifest.candidate.git_tree,
        version: manifest.candidate.version,
        tarball: manifest.npm.tarball.path,
        tarball_sha256: manifest.npm.tarball.sha256,
      })}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const manifest = await verifyReleaseCandidate({
      repository_root: localPath('repository'),
      candidate_root: localPath('candidate'),
    });
    process.stdout.write(
      `${JSON.stringify({
        verified: true,
        candidate_fingerprint: manifest.candidate.fingerprint,
        git_sha: manifest.candidate.git_sha,
        git_tree: manifest.candidate.git_tree,
        version: manifest.candidate.version,
        records: manifest.live_validation.artifact_hashes,
      })}\n`,
    );
    return;
  }
  usage();
}

await main();
