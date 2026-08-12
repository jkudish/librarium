import { createHash } from 'node:crypto';
import { sanitizeId } from './constants.js';

export interface ProviderArtifactFileNames {
  readonly outputFile: string;
  readonly metaFile: string;
}

/** Collision-resistant names shared by v2 compatibility and v3 presentation. */
export function providerArtifactFileNames(
  providerId: string,
): ProviderArtifactFileNames {
  const stem = sanitizeId(providerId).slice(0, 64) || 'provider';
  const digest = createHash('sha256').update(providerId, 'utf8').digest('hex');
  return {
    outputFile: `provider-${stem}--${digest}.md`,
    metaFile: `provider-${stem}--${digest}.meta.json`,
  };
}
