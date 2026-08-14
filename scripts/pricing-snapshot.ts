import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type PricingSnapshotInput,
  pricingSnapshotFingerprint,
  validatePricingSnapshot,
  verifyPricingSnapshotFingerprint,
} from '../src/core/pricing.js';

const ZERO_FINGERPRINT = `sha256:${'0'.repeat(64)}`;
const REMOTE_PATH_PATTERN = /^(?:(?:https?|ftp|data|file):|\\\\)/i;
const REVIEWER_PATTERN = /^[a-z0-9][a-z0-9._@-]{0,63}$/i;

interface ReviewReceipt {
  readonly schema_version: 1;
  readonly decision: 'approved';
  readonly reviewer: string;
  readonly reviewed_at: string;
  readonly snapshot_version: string;
  readonly snapshot_fingerprint: string;
}

function usage(): never {
  throw new Error(
    'Usage: pricing-snapshot <sync|review|freeze> --input <local-json> --output <local-json> [--reviewer <id> | --review <receipt-json>]',
  );
}

function option(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) usage();
  return value;
}

function localPath(value: string | undefined, label: string): string {
  if (!value) usage();
  if (REMOTE_PATH_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a local filesystem path; remote inputs are denied.`,
    );
  }
  return resolve(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function readJson(path: string, label: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    throw new Error(`${label} could not be read.`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function stagedSnapshot(value: unknown): PricingSnapshotInput {
  const candidate = record(value, 'Pricing candidate');
  const provisional = validatePricingSnapshot({
    ...candidate,
    fingerprint: ZERO_FINGERPRINT,
  } as unknown as PricingSnapshotInput);
  const fingerprint = pricingSnapshotFingerprint(provisional);
  const staged = validatePricingSnapshot({ ...provisional, fingerprint });
  verifyPricingSnapshotFingerprint(staged);
  return staged;
}

function approvedSnapshot(value: unknown): PricingSnapshotInput {
  const snapshot = validatePricingSnapshot(
    record(value, 'Pricing snapshot') as unknown as PricingSnapshotInput,
  );
  verifyPricingSnapshotFingerprint(snapshot);
  return snapshot;
}

function reviewReceipt(value: unknown): ReviewReceipt {
  const receipt = record(value, 'Pricing review receipt');
  const allowed = new Set([
    'schema_version',
    'decision',
    'reviewer',
    'reviewed_at',
    'snapshot_version',
    'snapshot_fingerprint',
  ]);
  if (
    Object.keys(receipt).some((key) => !allowed.has(key)) ||
    receipt.schema_version !== 1 ||
    receipt.decision !== 'approved' ||
    typeof receipt.reviewer !== 'string' ||
    !REVIEWER_PATTERN.test(receipt.reviewer) ||
    typeof receipt.reviewed_at !== 'string' ||
    !receipt.reviewed_at.endsWith('Z') ||
    !Number.isFinite(Date.parse(receipt.reviewed_at)) ||
    typeof receipt.snapshot_version !== 'string' ||
    receipt.snapshot_version.length === 0 ||
    receipt.snapshot_version.length > 256 ||
    typeof receipt.snapshot_fingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.snapshot_fingerprint)
  ) {
    throw new Error('Pricing review receipt is malformed.');
  }
  return receipt as unknown as ReviewReceipt;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['sync', 'review', 'freeze'].includes(command ?? '')) usage();
  const input = localPath(option('input'), 'Input');
  const output = localPath(option('output'), 'Output');

  if (command === 'sync') {
    const candidate = stagedSnapshot(
      await readJson(input, 'Pricing candidate'),
    );
    await writeJson(output, candidate);
    console.log(`Staged local pricing candidate ${candidate.fingerprint}.`);
    return;
  }

  const snapshot = approvedSnapshot(await readJson(input, 'Pricing snapshot'));
  if (command === 'review') {
    const reviewer = option('reviewer');
    if (!reviewer || !REVIEWER_PATTERN.test(reviewer)) {
      throw new Error('Reviewer must be a bounded non-secret identifier.');
    }
    const receipt: ReviewReceipt = {
      schema_version: 1,
      decision: 'approved',
      reviewer,
      reviewed_at: new Date().toISOString(),
      snapshot_version: snapshot.version,
      snapshot_fingerprint: snapshot.fingerprint,
    };
    await writeJson(output, receipt);
    console.log(`Approved pricing candidate ${snapshot.fingerprint}.`);
    return;
  }

  const receiptPath = localPath(option('review'), 'Review receipt');
  const receipt = reviewReceipt(
    await readJson(receiptPath, 'Pricing review receipt'),
  );
  if (
    receipt.snapshot_version !== snapshot.version ||
    receipt.snapshot_fingerprint !== snapshot.fingerprint
  ) {
    throw new Error('Pricing review receipt does not match the snapshot.');
  }
  await writeJson(output, snapshot);
  console.log(`Froze reviewed pricing snapshot ${snapshot.fingerprint}.`);
}

await main();
