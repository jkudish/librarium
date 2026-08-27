# Immutable release promotion and recovery

The release-candidate workflow certifies exact bytes but has no publication authority. The release workflow promotes those bytes without changing source, package metadata, tags, artifacts, or provenance. It is owner-only and uses the `release` environment.

## Required repository setup

Before publication, a repository administrator must create the `release` environment in **Settings → Environments** and configure:

- at least one required reviewer; and
- deployment restricted to protected branches.

The workflow performs a read-only GitHub API preflight and fails before candidate checkout when either rule is absent. Merely writing `environment: release` in workflow YAML does not protect it: GitHub can auto-create an unprotected environment. Repository settings are therefore a required publication boundary and are not configured by this repository.

## Certification and version identity

Certification requires an explicit, default-free `release_kind`:

- `rc` requires the committed package and lock identity `X.Y.Z-rc.N` and publishes npm with dist-tag `rc` plus a prerelease GitHub release;
- `stable` requires the separately committed package and lock identity `X.Y.Z` and publishes npm with dist-tag `latest` plus a non-prerelease GitHub release.

Both modes run the same package, SEA, installer, Homebrew, and distribution proofs and produce the same immutable candidate archive shape. Promotion derives behavior from the certified version and rejects a mismatched kind or dist-tag. It never renames an RC tarball to stable: npm package identity is inside the bytes, so stable publication requires a newly reviewed stable-version commit and successful stable certification run.

Record all four promotion inputs from one successful certification run: the full protected-main SHA, `sha256:...` candidate fingerprint, SHA-256 of `candidate.tar.gz`, and certification run ID. Before any write, promotion verifies that run, archive checksum, candidate contents, and staged publication bytes.

## Cross-channel identity

The workflow repeatedly inventories providers and fails closed unless:

- a new promotion's protected `main` tip equals the candidate SHA;
- npm is absent or its downloaded tarball SHA-256 equals the candidate tarball, and the expected `rc` or `latest` dist-tag is exact or can move only forward;
- an RC does not own npm's `latest` tag;
- the Git tag is absent or resolves to the candidate SHA;
- the GitHub release is absent or targets the candidate SHA, with no unexpected, duplicate, or mismatched asset;
- a Homebrew formula for this exact version is absent or byte-identical to the derived formula.

The GitHub release publishes the npm tarball, five SEA binaries, `candidate.json`, provenance, and `SHA256SUMS`. The checksum manifest records candidate SHA, fingerprint, and version plus every asset digest. The standalone installer verifies those identity headers and the selected SEA digest before replacement, then verifies the binary-reported version. Homebrew records the same candidate SHA, fingerprint, version, and SEA digests.

## Forward-only order

Promotion advances through exact npm bytes and expected dist-tag, immutable Git tag, GitHub release, absent GitHub assets, then one Homebrew commit. There is no force tag, force push, asset clobber, ignored push failure, source mutation, or rebuild. Provider races fail rather than overwrite.

## Recovery after `main` advances

Use `promotion_mode: new` for first publication. It requires current protected `main` to equal the certified candidate SHA.

Use `promotion_mode: recover` only after an uncertain or partial npm write. Recovery requires all of these invariants:

1. the same successful certification run ID, candidate SHA, fingerprint, and archive hash are supplied;
2. the workflow checks out that exact candidate and verifies its unchanged archive bytes;
3. the candidate remains an ancestor of current protected `main`;
4. npm already contains that exact candidate tarball; recovery cannot initiate npm publication after `main` advances;
5. every existing channel object matches the same candidate, and reconciliation resumes only at an absent later boundary.

If npm bytes exist but their expected dist-tag is missing or points to an older version, recovery may restore that tag to the exact candidate. A newer expected tag, RC on `latest`, mismatched tarball, tag target, release target, asset, or same-version Homebrew formula is a terminal conflict for that version.

Stop after an uncertain write and preserve the run URL, inputs, `promotion.json`, and inventory. Inspect channels read-only; do not delete, replace, unpublish, amend, or force-push. Out-of-order state is a conflict, not permission to skip ahead. No recovery approval itself authorizes workflow dispatch, publication, tagging, deployment, or repository-settings changes.
