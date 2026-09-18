import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type PricingSnapshotInput,
  verifyPricingSnapshotFingerprint,
} from '../src/core/pricing.js';
import { BUILTIN_PRICING_SNAPSHOT } from '../src/core/pricing-snapshot.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';

const createdDirectories: string[] = [];
const workflow = join(process.cwd(), 'scripts/pricing-snapshot.mjs');

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'librarium-pricing-'));
  createdDirectories.push(directory);
  return directory;
}

function run(...arguments_: string[]) {
  return spawnSync(process.execPath, [workflow, ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('offline pricing snapshot workflow', () => {
  it('stages, explicitly reviews, and freezes the same immutable snapshot', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.json');
    const candidate = join(directory, 'candidate.json');
    const receipt = join(directory, 'review.json');
    const frozen = join(directory, 'frozen.json');
    const unfingerprinted = { ...BUILTIN_PRICING_SNAPSHOT, fingerprint: '' };
    await writeFile(input, JSON.stringify(unfingerprinted), 'utf8');

    expect(run('sync', '--input', input, '--output', candidate).status).toBe(0);
    expect(
      run(
        'review',
        '--input',
        candidate,
        '--output',
        receipt,
        '--reviewer',
        'pricing-review',
      ).status,
    ).toBe(0);
    expect(
      run(
        'freeze',
        '--input',
        candidate,
        '--output',
        frozen,
        '--review',
        receipt,
      ).status,
    ).toBe(0);

    const result = JSON.parse(
      await readFile(frozen, 'utf8'),
    ) as PricingSnapshotInput;
    expect(result.fingerprint).toBe(BUILTIN_PRICING_SNAPSHOT.fingerprint);
    expect(() => verifyPricingSnapshotFingerprint(result)).not.toThrow();
  });

  it('rejects remote inputs and a review receipt for different content', async () => {
    const remote = run(
      'sync',
      '--input',
      'https://example.com/pricing.json',
      '--output',
      'candidate.json',
    );
    expect(remote.status).not.toBe(0);
    expect(remote.stderr).toContain('remote inputs are denied');

    const directory = await temporaryDirectory();
    const candidate = join(directory, 'candidate.json');
    const receipt = join(directory, 'review.json');
    const frozen = join(directory, 'frozen.json');
    await writeFile(
      candidate,
      JSON.stringify(BUILTIN_PRICING_SNAPSHOT),
      'utf8',
    );
    await writeFile(
      receipt,
      JSON.stringify({
        schema_version: 1,
        decision: 'approved',
        reviewer: 'pricing-review',
        reviewed_at: '2026-08-13T00:00:00.000Z',
        snapshot_version: BUILTIN_PRICING_SNAPSHOT.version,
        snapshot_fingerprint: `sha256:${'f'.repeat(64)}`,
      }),
      'utf8',
    );

    const mismatch = run(
      'freeze',
      '--input',
      candidate,
      '--output',
      frozen,
      '--review',
      receipt,
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('does not match');
  });

  it.each([
    ['non-object snapshot', []],
    [
      'unknown snapshot field',
      { ...BUILTIN_PRICING_SNAPSHOT, unexpected: true },
    ],
    [
      'malformed definition shape',
      {
        ...BUILTIN_PRICING_SNAPSHOT,
        definitions: [
          {
            ...BUILTIN_PRICING_SNAPSHOT.definitions[0],
            rates: 'not-an-array',
          },
        ],
      },
    ],
    [
      'invalid runtime enum',
      {
        ...BUILTIN_PRICING_SNAPSHOT,
        definitions: [
          {
            ...BUILTIN_PRICING_SNAPSHOT.definitions[0],
            completeness: 'free',
          },
        ],
      },
    ],
    [
      'oversized unit collection',
      {
        ...BUILTIN_PRICING_SNAPSHOT,
        definitions: [
          {
            ...BUILTIN_PRICING_SNAPSHOT.definitions[0],
            expected_units: Array.from({ length: 65 }, () => 'requests'),
          },
        ],
      },
    ],
  ])('rejects %s from candidate JSON', async (_label, value) => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.json');
    const candidate = join(directory, 'candidate.json');
    await writeFile(input, JSON.stringify(value), 'utf8');

    const result = run('sync', '--input', input, '--output', candidate);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });

  it('does not access the network during ordinary catalog resolution', () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network denied'));
    buildProviderCatalog();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
