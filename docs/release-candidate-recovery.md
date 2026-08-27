# Immutable release promotion and recovery

The release-candidate workflow certifies exact bytes but has no publication authority. The release workflow promotes those bytes without changing source, package metadata, tags, artifacts, or provenance. It is restricted to the repository owner, protected `main`, the exact certified SHA, and the protected `release` environment.

## Promotion authority

Record all four workflow inputs from one successful release-candidate run:

- the full protected-main Git SHA;
- the `sha256:...` candidate fingerprint from `candidate.json`;
- the SHA-256 of the downloaded `candidate.tar.gz` artifact;
- the certification workflow run ID that owns the SHA-qualified artifact.

The committed candidate version is the publication version. Promotion does not turn `X.Y.Z-rc.N` bytes into `X.Y.Z`, update the changelog, commit, rebuild, or infer identity from a mutable tag. A stable `X.Y.Z` publication therefore requires a separately committed and certified candidate contract that permits that exact stable identity; the current candidate contract permits only `X.Y.Z-rc.N`.

### Stable `2.0.0` blocker and recommendation

This workflow cannot publish the current RC tarball as npm `2.0.0`: npm reads the version from the package bytes, so renaming the file or changing only the tag cannot change package identity. Mutating `package.json` or repacking would produce uncertified bytes.

The recommended next step is a separate immutable final-version certification flow. Commit `2.0.0` in `package.json` and both package-lock version fields through normal protected-main review, update the candidate authority to accept an explicitly final certification mode, and run the same package/SEA/distribution proof to produce a new SHA-, version-, fingerprint-, and archive-hash-qualified artifact. Only that newly certified `2.0.0` tarball may enter stable promotion. Until that flow and artifact exist, stable npm `2.0.0` publication is blocked; this workflow intentionally promotes only the exact RC version as a prerelease.

Before any write, promotion verifies the archive checksum, safely extracts regular files only, runs the full candidate verifier, and derives `promotion.json`, release `SHA256SUMS`, and the Homebrew formula. The staged npm tarball, five SEA binaries, `candidate.json`, and provenance are copied byte-for-byte from the candidate.

## Cross-channel identity

The workflow repeatedly inventories providers and fails closed unless:

- protected `main` equals the candidate SHA;
- npm is absent or its downloaded tarball SHA-256 equals the candidate tarball;
- the tag is absent or resolves to the candidate SHA;
- the GitHub release is absent or targets the candidate SHA, with no unexpected, duplicate, or mismatched asset;
- a Homebrew formula for this exact version is absent or byte-identical to the derived formula.

The GitHub release publishes the npm tarball, five SEA binaries, `candidate.json`, provenance, and `SHA256SUMS`. The checksum manifest records candidate SHA, fingerprint, and version headers plus every asset digest. The standalone installer requires that manifest, verifies its identity headers and the selected SEA digest before replacement, then verifies the binary-reported version. Homebrew records the candidate SHA and fingerprint in the formula and uses the same SEA digests. Final verification redownloads npm and every GitHub asset and compares all channel identities with `promotion.json`.

## Forward-only order

Promotion advances in this order:

1. exact npm tarball;
2. new immutable Git tag;
3. new GitHub release;
4. only absent GitHub assets;
5. one new Homebrew commit.

There is no force tag, force push, asset clobber, ignored push failure, source mutation, or rebuild. Provider races fail rather than overwrite. A rerun starts from a fresh read-only inventory and treats an existing exact object as complete.

## Recovery procedure

1. Stop at the first failed or uncertain write. Preserve the run URL, logs, four workflow inputs, `promotion.json`, and final known inventory.
2. Do not manually delete, replace, move, unpublish, amend, or force-push anything.
3. Inspect every channel read-only. Download npm and GitHub assets; do not trust version strings, provider exit codes, or names alone.
4. If every existing object matches `promotion.json`, rerun the same workflow from the same protected-main SHA with the same four inputs. Reconciliation resumes at the first absent later stage.
5. If npm exists exactly and the tag is absent, preserve npm and resume with tag creation. If the tag exists exactly and the release is absent, preserve both and resume with release creation. If a release contains an exact subset of assets, upload only its missing assets. If release assets are complete and Homebrew is absent, add only the forward Homebrew commit.
6. Treat any differing npm tarball, tag target, release target, asset body/name set, checksum manifest, provenance, or same-version Homebrew formula as terminal for that version. Do not repair in place. Commit a new candidate identity, certify it, and promote that new version.
7. Treat out-of-order state (tag without npm, release without tag, or Homebrew without complete assets) as a conflict requiring investigation, not permission to skip ahead.

No recovery approval authorizes workflow dispatch, npm/GitHub/Homebrew publication, tagging, or deployment. Those remain separate owner actions through the protected release environment.
