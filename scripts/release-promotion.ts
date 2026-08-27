import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseReleasePromotionInventory,
  parseReleasePromotionSpec,
  prepareReleasePromotion,
  reconcileReleasePromotion,
  verifyPromotionStaging,
} from '../src/node-release-promotion.js';

function option(name: string): string {
  const flag = `--${name}`;
  const indexes = process.argv.flatMap((value, index) =>
    value === flag ? [index] : [],
  );
  if (indexes.length !== 1) throw new Error(`Expected exactly one ${flag}.`);
  const value = process.argv[indexes[0]! + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${flag}.`);
  return value;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function githubOutput(values: Readonly<Record<string, string | boolean>>): void {
  if (!process.argv.includes('--github-output')) return;
  const path = process.env.GITHUB_OUTPUT;
  if (!path) throw new Error('GITHUB_OUTPUT is required.');
  for (const [name, value] of Object.entries(values)) {
    appendFileSync(path, `${name}=${String(value)}\n`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'prepare') {
    const spec = await prepareReleasePromotion({
      repository_root: resolve(option('repository')),
      candidate_root: resolve(option('candidate')),
      output_root: resolve(option('output')),
    });
    process.stdout.write(`${JSON.stringify(spec)}\n`);
    return;
  }
  if (command === 'verify') {
    const spec = verifyPromotionStaging(option('promotion'));
    process.stdout.write(`${JSON.stringify({ verified: true, ...spec.candidate })}\n`);
    return;
  }
  if (command === 'reconcile') {
    const spec = parseReleasePromotionSpec(json(option('spec')));
    const inventory = parseReleasePromotionInventory(json(option('inventory')));
    const plan = reconcileReleasePromotion(spec, inventory);
    githubOutput({
      complete: plan.complete,
      publish_npm: plan.publish_npm,
      create_tag: plan.create_tag,
      create_github_release: plan.create_github_release,
      upload_github_assets: plan.upload_github_assets.join(','),
      publish_homebrew: plan.publish_homebrew,
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  throw new Error(
    'Usage: release-promotion <prepare|verify|reconcile> [options]',
  );
}

await main();
