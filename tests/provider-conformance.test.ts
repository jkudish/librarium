import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILE_BINDING_SPECS } from '../src/core/profile-bindings.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  catalogProfileRefs,
} from '../src/core/provider-profiles.js';
import {
  PROVIDER_CONFORMANCE_EVIDENCE,
  type ProviderConformanceLane,
} from './fixtures/provider-conformance.js';

const requiredForAll: readonly ProviderConformanceLane[] = [
  'credentials',
  'normalization',
  'safe_failure',
  'provenance',
  'metering',
];

function key(providerId: string, profileId: string): string {
  return `${providerId}/${profileId}`;
}

describe('built-in provider conformance inventory', () => {
  const implemented = catalogProfileRefs()
    .filter(({ declaration }) => declaration.status === 'implemented')
    .map(({ entry, declaration }) =>
      key(entry.provider_id, declaration.profile_id),
    )
    .sort();

  it('requires exact evidence for every implemented public profile', () => {
    expect(Object.keys(PROVIDER_CONFORMANCE_EVIDENCE).sort()).toEqual(
      implemented,
    );
    expect(implemented).toHaveLength(41);
  });

  it('keeps every implemented profile bound to one executable strategy', () => {
    const bindings = BUILTIN_PROFILE_BINDING_SPECS.map((binding) =>
      key(binding.provider_id, binding.profile_id),
    );
    expect(new Set(bindings).size).toBe(bindings.length);
    expect([...bindings].sort()).toEqual(implemented);
  });

  it('points to real tests and declares coherent contract lanes', () => {
    for (const { entry, declaration } of catalogProfileRefs()) {
      if (declaration.status !== 'implemented') continue;
      const profileKey = key(entry.provider_id, declaration.profile_id);
      const evidence = PROVIDER_CONFORMANCE_EVIDENCE[profileKey];
      expect(evidence, profileKey).toBeDefined();
      expect(new Set(evidence?.lanes).size, profileKey).toBe(
        evidence?.lanes.length,
      );
      for (const lane of requiredForAll) {
        expect(evidence?.lanes, `${profileKey}:${lane}`).toContain(lane);
      }
      if (declaration.invocation === 'background') {
        expect(evidence?.lanes, `${profileKey}:lifecycle`).toContain(
          'lifecycle',
        );
      }
      if (declaration.grounding_policy === 'required') {
        expect(evidence?.lanes, `${profileKey}:citations`).toContain(
          'citations',
        );
      }
      expect(evidence?.evidence.length, profileKey).toBeGreaterThan(0);
      for (const path of evidence?.evidence ?? []) {
        expect(existsSync(path), `${profileKey}:${path}`).toBe(true);
      }
    }
    expect(BUILTIN_PROVIDER_CATALOG).not.toHaveLength(0);
  });
});
