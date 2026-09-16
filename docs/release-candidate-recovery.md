# Immutable release promotion and recovery

The release-candidate workflow certifies exact bytes but has no publication authority. The release workflow promotes those bytes without changing source, package metadata, tags, artifacts, or provenance. It is owner-only and uses the `release` environment.

This is an operator procedure for the workflows committed in this repository,
not a record that v2 has been certified or published. A `2.0.0` source version
does not establish an npm dist-tag, GitHub release, standalone download, or
Homebrew version. Verify each channel read-only before directing users to it.
Certification dispatch and publication each require explicit authorization;
documentation review grants neither. Historical release records remain
history, not evidence that the current source is distributed.

## Required repository setup

Before publication, a repository administrator must create the `release` environment in **Settings → Environments** and configure:

- at least one required reviewer; and
- deployment restricted to protected branches; and
- an environment secret named `NPM_TOKEN`, containing a granular npm token with write access to `librarium` and bypass-2FA enabled; and
- an environment secret named `HOMEBREW_TAP_TOKEN`, containing a GitHub credential scoped to `jkudish/homebrew-tap` with repository Contents read/write permission and permission under that repository's branch rules to push the one forward-only formula commit directly to `main`.

`NPM_TOKEN` is exposed only to the recovery step that restores an expected npm dist-tag. npm trusted-publishing OIDC authenticates `npm publish`, but not `npm dist-tag add`; the latter therefore requires traditional authentication. `HOMEBREW_TAP_TOKEN` is exposed to a read-only readiness check before publication and to the final Homebrew publication step. The workflow performs a read-only GitHub API preflight and fails before candidate checkout when either environment-protection rule is absent. Merely writing `environment: release` in workflow YAML does not protect it: GitHub can auto-create an unprotected environment. Repository settings and secrets are therefore required publication boundaries and are not configured by this repository.

## Read-only readiness before dispatch

Complete these checks before approving promotion. npm publication is the first
irreversible write. The workflow checks that the Homebrew credential is present,
can read the tap's main ref, and reports repository-level push permission before
that write. This cannot guarantee a later write succeeds or bypass branch rules.

1. Confirm the protected `release` environment lists both required secret
   names. GitHub never returns their values:

   ```bash
   gh api repos/jkudish/librarium/environments/release/secrets \
     --jq '[.secrets[].name] | contains(["NPM_TOKEN", "HOMEBREW_TAP_TOKEN"])'
   ```

   Continue only when the command prints `true`.
2. From a secure operator shell where the candidate Homebrew token is already
   available, make a read-only repository request with that credential:

   ```bash
   GH_TOKEN="$HOMEBREW_TAP_TOKEN" \
     gh api repos/jkudish/homebrew-tap --jq '.permissions.push == true'
   ```

   Continue only when it prints `true`, and separately confirm the current
   `main` branch rules permit that token's principal to push directly. The API
   check proves repository-level push permission but does not bypass branch
   rules and does not mutate the tap.
3. Inspect npm, the Git tag, the GitHub release and assets, and the Homebrew
   formula read-only. Resolve every mismatch or unavailable lookup before
   dispatch; do not use a publication run as a credential or channel probe.

## Certification and version identity

Certification requires an explicit, default-free `release_kind`:

- `rc` requires the committed package and lock identity `X.Y.Z-rc.N`; subsequent authorized promotion uses npm dist-tag `rc` plus a prerelease GitHub release;
- `stable` requires the separately committed package and lock identity `X.Y.Z`; subsequent authorized promotion uses npm dist-tag `latest` plus a non-prerelease GitHub release.

Both modes run the same package, SEA, installer, Homebrew, and distribution proofs and produce the same immutable candidate archive shape. Promotion derives behavior from the certified version and rejects a mismatched kind or dist-tag. It never renames an RC tarball to stable: npm package identity is inside the bytes, so stable publication requires a newly reviewed stable-version commit and successful stable certification run.

Record all four promotion inputs from one successful certification run: the full protected-main SHA, `sha256:...` candidate fingerprint, SHA-256 of `candidate.tar.gz`, and certification run ID. Before any write, promotion verifies that run, archive checksum, candidate contents, and staged publication bytes.

Candidate workflow artifacts are retained for 30 days. Complete promotion within that window. An expired artifact cannot be reconstructed or substituted; certify a new immutable candidate instead.

## Cross-channel identity

The workflow repeatedly inventories providers and fails closed unless:

- a new promotion's protected `main` tip equals the candidate SHA;
- npm is absent or its downloaded tarball SHA-256 equals the candidate tarball, and the expected `rc` or `latest` dist-tag is exact or can move only forward;
- an RC does not own npm's `latest` tag;
- the Git tag is absent or resolves to the candidate SHA;
- the GitHub release is absent or targets the candidate SHA, with no unexpected, duplicate, or mismatched asset;
- a Homebrew formula for this exact version is absent or byte-identical to the derived formula.

The GitHub release publishes the npm tarball, five SEA binaries, `candidate.json`, provenance, and `SHA256SUMS`. The checksum manifest records candidate SHA, fingerprint, and version plus every asset digest. For a GitHub release download, the standalone installer validates the manifest's identity-header shapes and selected SEA digest; when the caller supplies `LIBRARIUM_CANDIDATE_SHA` or `LIBRARIUM_CANDIDATE_FINGERPRINT`, it also requires an exact match. It then verifies the binary-reported version. Local `LIBRARIUM_CANDIDATE` mode requires the binary's SHA-256 and version, but does not validate those optional provenance values against a local manifest; establish local candidate provenance through the certification evidence instead. Homebrew records the same candidate SHA, fingerprint, version, and SEA digests.

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
