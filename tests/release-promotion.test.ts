import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseReleasePromotionInventory,
  parseReleasePromotionSpec,
  type ReleasePromotionInventory,
  type ReleasePromotionSpec,
  reconcileReleasePromotion,
} from '../src/node-release-promotion.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;

const spec: ReleasePromotionSpec = {
  schema_version: 1,
  contract: 'librarium-release-promotion',
  repository: 'jkudish/librarium',
  candidate: {
    git_sha: SHA,
    git_tree: 'c'.repeat(40),
    version: '2.0.0-rc.19',
    fingerprint: `sha256:${'d'.repeat(64)}`,
    release_kind: 'rc',
  },
  tag: 'v2.0.0-rc.19',
  npm: {
    asset: 'librarium-2.0.0-rc.19.tgz',
    sha256: DIGEST,
    dist_tag: 'rc',
  },
  github_assets: {
    'librarium-2.0.0-rc.19.tgz': DIGEST,
    'librarium-linux-x64': OTHER_DIGEST,
    SHA256SUMS: `sha256:${'3'.repeat(64)}`,
  },
  checksum_manifest: 'SHA256SUMS',
  homebrew_formula: {
    path: 'Formula/librarium.rb',
    sha256: `sha256:${'4'.repeat(64)}`,
  },
};

function inventory(
  change: Partial<ReleasePromotionInventory> = {},
): ReleasePromotionInventory {
  return {
    branch_sha: SHA,
    tag_sha: null,
    npm_sha256: null,
    npm_dist_tags: {},
    github_release: null,
    homebrew_version: null,
    homebrew_formula_sha256: null,
    ...change,
  };
}

describe('immutable release promotion identity', () => {
  it('strictly parses version-qualified candidate identity', () => {
    expect(parseReleasePromotionSpec(JSON.parse(JSON.stringify(spec)))).toEqual(
      spec,
    );
    expect(() => parseReleasePromotionSpec({ ...spec, tag: 'v2.0.0' })).toThrow(
      'exact candidate version',
    );
    const stable = {
      ...spec,
      candidate: {
        ...spec.candidate,
        version: '2.0.0',
        release_kind: 'stable',
      },
      tag: 'v2.0.0',
      npm: {
        ...spec.npm,
        asset: 'librarium-2.0.0.tgz',
        dist_tag: 'latest',
      },
      github_assets: {
        'librarium-2.0.0.tgz': DIGEST,
        'librarium-linux-x64': OTHER_DIGEST,
        SHA256SUMS: `sha256:${'3'.repeat(64)}`,
      },
    };
    expect(parseReleasePromotionSpec(stable)).toMatchObject({
      candidate: { release_kind: 'stable' },
      npm: { dist_tag: 'latest' },
    });
    expect(() =>
      parseReleasePromotionSpec({
        ...stable,
        candidate: { ...stable.candidate, release_kind: 'rc' },
      }),
    ).toThrow('release kind');
  });

  it('rejects malformed and excess remote inventory fields', () => {
    expect(() =>
      parseReleasePromotionInventory({
        ...inventory(),
        ignored_provider_state: true,
      }),
    ).toThrow('fields are invalid');
    expect(() =>
      parseReleasePromotionInventory({ ...inventory(), npm_sha256: 'latest' }),
    ).toThrow('npm SHA-256');
  });
});

describe('forward-only release recovery', () => {
  it('advances one immutable boundary at a time', () => {
    expect(reconcileReleasePromotion(spec, inventory(), 'new')).toMatchObject({
      publish_npm: true,
      create_tag: false,
    });
    expect(
      reconcileReleasePromotion(spec, inventory({ npm_sha256: DIGEST }), 'new'),
    ).toMatchObject({
      publish_npm: false,
      set_npm_dist_tag: true,
      create_tag: false,
    });
    expect(
      reconcileReleasePromotion(
        spec,
        inventory({
          npm_sha256: DIGEST,
          npm_dist_tags: { rc: spec.candidate.version },
          tag_sha: SHA,
        }),
        'new',
      ),
    ).toMatchObject({ create_github_release: true });
  });

  it('resumes a partial exact GitHub release with only missing assets', () => {
    const plan = reconcileReleasePromotion(
      spec,
      inventory({
        npm_sha256: DIGEST,
        npm_dist_tags: { rc: spec.candidate.version },
        tag_sha: SHA,
        github_release: {
          target_sha: SHA,
          assets: { 'librarium-2.0.0-rc.19.tgz': DIGEST },
        },
      }),
      'new',
    );
    expect(plan.upload_github_assets).toEqual([
      'SHA256SUMS',
      'librarium-linux-x64',
    ]);
    expect(plan.publish_homebrew).toBe(false);
  });

  it('recognizes complete identical publication', () => {
    expect(
      reconcileReleasePromotion(
        spec,
        inventory({
          npm_sha256: DIGEST,
          npm_dist_tags: { rc: spec.candidate.version },
          tag_sha: SHA,
          github_release: {
            target_sha: SHA,
            assets: spec.github_assets,
          },
          homebrew_version: spec.candidate.version,
          homebrew_formula_sha256: spec.homebrew_formula.sha256,
        }),
        'new',
      ).complete,
    ).toBe(true);
  });

  it('permits one forward Homebrew commit over an earlier formula', () => {
    const plan = reconcileReleasePromotion(
      spec,
      inventory({
        npm_sha256: DIGEST,
        npm_dist_tags: { rc: spec.candidate.version },
        tag_sha: SHA,
        github_release: {
          target_sha: SHA,
          assets: spec.github_assets,
        },
        homebrew_version: '1.9.9',
      }),
      'new',
    );
    expect(plan.publish_homebrew).toBe(true);
    expect(plan.complete).toBe(false);
  });

  it.each([
    ['branch', { branch_sha: OTHER_SHA }],
    ['npm', { npm_sha256: OTHER_DIGEST }],
    ['tag', { npm_sha256: DIGEST, tag_sha: OTHER_SHA }],
    [
      'release target',
      {
        npm_sha256: DIGEST,
        tag_sha: SHA,
        github_release: { target_sha: OTHER_SHA, assets: {} },
      },
    ],
    [
      'release asset',
      {
        npm_sha256: DIGEST,
        tag_sha: SHA,
        github_release: {
          target_sha: SHA,
          assets: { 'librarium-linux-x64': DIGEST },
        },
      },
    ],
    [
      'unexpected release asset',
      {
        npm_sha256: DIGEST,
        tag_sha: SHA,
        github_release: {
          target_sha: SHA,
          assets: { surprise: DIGEST },
        },
      },
    ],
    [
      'Homebrew',
      {
        homebrew_version: spec.candidate.version,
        homebrew_formula_sha256: OTHER_DIGEST,
      },
    ],
    ['Homebrew downgrade', { homebrew_version: '2.0.0' }],
  ] as const)('fails closed on %s conflict', (_label, change) => {
    expect(() =>
      reconcileReleasePromotion(spec, inventory(change), 'new'),
    ).toThrow();
  });

  it.each([
    ['tag before npm', { tag_sha: SHA }],
    [
      'release before tag',
      { npm_sha256: DIGEST, github_release: { target_sha: SHA, assets: {} } },
    ],
    [
      'Homebrew before release assets',
      {
        npm_sha256: DIGEST,
        tag_sha: SHA,
        homebrew_version: spec.candidate.version,
        homebrew_formula_sha256: spec.homebrew_formula.sha256,
      },
    ],
  ] as const)('rejects %s', (_label, change) => {
    expect(() =>
      reconcileReleasePromotion(spec, inventory(change), 'new'),
    ).toThrow('not forward-only');
  });

  it('allows only exact-byte recovery after protected main advances', () => {
    expect(
      reconcileReleasePromotion(
        spec,
        inventory({
          branch_sha: OTHER_SHA,
          npm_sha256: DIGEST,
          npm_dist_tags: { rc: spec.candidate.version },
        }),
        'recover',
      ),
    ).toMatchObject({ create_tag: true, publish_npm: false });
    expect(() =>
      reconcileReleasePromotion(
        spec,
        inventory({ branch_sha: OTHER_SHA }),
        'recover',
      ),
    ).toThrow('exact candidate bytes');
    expect(() =>
      reconcileReleasePromotion(
        spec,
        inventory({ branch_sha: OTHER_SHA, npm_sha256: DIGEST }),
        'new',
      ),
    ).toThrow('Protected main');
    expect(() =>
      reconcileReleasePromotion(spec, inventory(), 'ambiguous' as 'new'),
    ).toThrow('explicitly new or recover');
  });

  it('fails closed on unsafe npm dist-tag state', () => {
    expect(() =>
      reconcileReleasePromotion(
        spec,
        inventory({
          npm_sha256: DIGEST,
          npm_dist_tags: { latest: spec.candidate.version },
        }),
        'new',
      ),
    ).toThrow('latest');
    expect(() =>
      reconcileReleasePromotion(
        spec,
        inventory({ npm_dist_tags: { rc: spec.candidate.version } }),
        'new',
      ),
    ).toThrow('absent');
    expect(() =>
      reconcileReleasePromotion(
        spec,
        inventory({ npm_dist_tags: { rc: '2.0.0' } }),
        'new',
      ),
    ).toThrow('newer');
  });
});

describe('release workflow policy', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const recovery = readFileSync('docs/release-candidate-recovery.md', 'utf8');

  it('is owner-only, SHA-qualified, pinned, and non-rebuilding', () => {
    expect(workflow).toContain("github.actor == 'jkudish'");
    expect(workflow).toContain('environment: release');
    expect(workflow).toContain('candidate_archive_sha256:');
    expect(workflow).toContain('candidate_fingerprint:');
    expect(workflow).toContain("'.conclusion'");
    expect(workflow).toContain('release-candidate.yml');
    expect(workflow).not.toMatch(/uses:\s*actions\/[^\s#]+@(?![0-9a-f]{40})/);
    expect(workflow).not.toContain('npm run build');
    expect(workflow).not.toContain('npm version');
    expect(workflow).not.toContain('--clobber');
    expect(workflow).not.toContain('git tag -f');
    expect(workflow).not.toContain('|| true');
    expect(workflow).toContain('--prerelease');
    expect(workflow).toContain('rc) PRERELEASE=(--prerelease)');
    expect(workflow).toContain('stable) ;;');
    expect(workflow).toContain('--tag "$DIST_TAG"');
    expect(workflow).toContain('npm dist-tag add');
    expect(workflow).toMatch(
      /permissions:\s*\n\s+actions: read\s*\n\s+contents: write/,
    );
    expect(workflow).toMatch(
      /name: Restore exact expected npm dist-tag[\s\S]*?NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}[\s\S]*?npm dist-tag add/,
    );
    const publishStep = workflow.slice(
      workflow.indexOf('- name: Publish exact certified npm tarball'),
      workflow.indexOf('- name: Reinspect after npm'),
    );
    expect(publishStep).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).toContain('--mode "$PROMOTION_MODE"');
    expect(workflow).toMatch(
      /promotion_mode:\s*\n\s+description:[^\n]*\n\s+required: true\s*\n\s+type: choice\s*\n\s+options:\s*\n\s+- new\s*\n\s+- recover/,
    );
    expect(workflow).not.toMatch(
      /promotion_mode:\s*[\s\S]{0,300}\n\s+default:/,
    );
    expect(workflow).toContain('git merge-base --is-ancestor');
    expect(workflow).toContain('environments/release');
    expect(workflow).toContain('.type == "required_reviewers"');
    expect(recovery).toContain('newly reviewed stable-version commit');
    expect(recovery).toContain('npm already contains that exact candidate');
    expect(recovery).toContain('environment secret named `NPM_TOKEN`');
    expect(recovery).toContain('retained for 30 days');
    expect(recovery).toContain(
      'Merely writing `environment: release` in workflow YAML does not protect it',
    );
    const privilegedCi = ci.slice(0, ci.indexOf('\n  test:'));
    expect(privilegedCi).not.toMatch(
      /uses:\s*actions\/[^\s#]+@(?![0-9a-f]{40})/,
    );
  });

  it('reinspects each provider boundary and verifies final identity', () => {
    expect(
      workflow.match(/release-inventory\.sh/g)?.length,
    ).toBeGreaterThanOrEqual(6);
    expect(workflow).toContain('npm publish "$RUNNER_TEMP/promotion/$ASSET"');
    expect(workflow).toContain('push origin "refs/tags/$TAG:refs/tags/$TAG"');
    expect(workflow).toContain('Upload only absent exact GitHub assets');
    expect(workflow).toContain('Verify complete cross-channel identity');
    expect(workflow).toContain(
      'npm registry did not expose the published candidate',
    );
    expect(workflow).toContain(
      'npm registry did not expose the expected dist-tag',
    );
    expect(workflow).toContain('Verify trusted-publishing toolchain floor');
    expect(workflow).toContain('11.5.1');
  });
});
