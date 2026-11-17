# Immutable release promotion and recovery

The release-candidate workflow certifies exact bytes but has no publication authority. The release workflow promotes those bytes without changing source, package metadata, tags, artifacts, or provenance. It is owner-only and uses the `release` environment.

This is an operator procedure for the workflows committed in this repository,
not a record of any certified or published release. A source version alone
does not establish an npm dist-tag, GitHub release, standalone download, or
Homebrew version. Verify each channel read-only before directing users to it.
Certification dispatch and publication each require explicit authorization;
documentation review grants neither. Historical release records remain
history, not evidence that the current source is distributed.

## Delegated release operator

Joey may authorize an agent to operate the existing owner-only workflow through the personal Amp secret `LIBRARIUM_RELEASE_GITHUB_TOKEN`. This is a standing fine-grained `jkudish` token with no expiry, created on 2026-11-17 for reuse across releases. Keep the value in Amp's secret store; do not copy it into this repository, logs, artifacts, or chat, and do not revoke it after a successful release. Refresh an orb with `amp orb restart-processes` when the secret is missing or has changed.

The token selects only `jkudish/librarium`, with repository **Actions read/write**, **Deployments read/write**, **Contents read-only**, and automatic Metadata read. Actions read-only is insufficient: a missing Actions write grant caused HTTP 403 on workflow dispatch during the first delegated release. The operator token needs no Contents write, Workflows write, Administration, Secrets, npm, or Homebrew permission. The workflow's own credentials perform publication.

Possession of this standing token is not release approval. **Each release still requires Joey's explicit go** covering the exact reviewed and certified candidate. Record that approval, the candidate identity, the run URL, and that an agent acts through Joey's delegated identity. Do not remove required reviewers, bypass protection, broaden token scopes, or change the workflow to get around an eligibility failure.

Before dispatch, verify `/user` is `jkudish`, `release` still requires that user, self-review prevention is off, protected-branch restriction remains enabled, certification succeeded for the approved SHA, and `main` equals that SHA for a `new` promotion. Download the certification artifact and compare `candidate.tar.gz` against the approved archive hash. Do not merge documentation or other changes into `main` while a new promotion still needs that exact tip.

Use command-scoped credentials, not an ambient GitHub login, and disable shell tracing:

```bash
set -euo pipefail
set +x
: "${LIBRARIUM_RELEASE_GITHUB_TOKEN:?Refresh Amp secrets before continuing}"
release_gh() { GH_TOKEN="$LIBRARIUM_RELEASE_GITHUB_TOKEN" gh "$@"; }
REPOSITORY=jkudish/librarium

test "$(release_gh api user --jq .login)" = jkudish
release_gh api "repos/$REPOSITORY/environments/release" \
  --jq '{id, name, protection_rules, deployment_branch_policy}'
```

Supply `CANDIDATE_SHA`, `CANDIDATE_FINGERPRINT`, `CANDIDATE_ARCHIVE_SHA256`, and `CERTIFICATION_RUN_ID` from one approved successful certification, never from an example or the latest run by position. Set `PROMOTION_MODE=new` for first publication. Dispatch once:

```bash
RUN_ID=$(release_gh api --method POST \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPOSITORY/actions/workflows/release.yml/dispatches" \
  -f ref=main \
  -f "inputs[candidate_sha]=$CANDIDATE_SHA" \
  -f "inputs[candidate_fingerprint]=$CANDIDATE_FINGERPRINT" \
  -f "inputs[candidate_archive_sha256]=$CANDIDATE_ARCHIVE_SHA256" \
  -f "inputs[certification_run_id]=$CERTIFICATION_RUN_ID" \
  -f "inputs[promotion_mode]=$PROMOTION_MODE" \
  --jq .workflow_run_id)
[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]]
```

If dispatch fails or its acknowledgement is lost, inspect workflow runs before retrying; it might already have started. For HTTP 403, check the stored token's selected repository and Actions **read/write** grant. Do not retry unchanged permissions or infer successful publication from a dispatch response.

Read back this exact run. Require its repository, workflow path, `workflow_dispatch` event, `main` branch, actor `jkudish`, and SHA to match the approved promotion. Once it is waiting for approval, read its pending deployments:

```bash
release_gh api "repos/$REPOSITORY/actions/runs/$RUN_ID" \
  --jq '{id, head_sha, head_branch, event, path, actor: .actor.login, html_url}'
ENVIRONMENT_ID=$(release_gh api "repos/$REPOSITORY/environments/release" --jq .id)
release_gh api "repos/$REPOSITORY/actions/runs/$RUN_ID/pending_deployments" \
  --jq '[.[] | {id: .environment.id, name: .environment.name, current_user_can_approve}]'
```

Proceed only when the pending list contains exactly that `release` environment and `current_user_can_approve` is true. An empty list means the run is not awaiting this approval; inspect rather than approving another run. After validating the list, approve only that run/environment, with the recorded approval and candidate SHA in the comment:

```bash
jq -n --argjson environment_id "$ENVIRONMENT_ID" \
  --arg comment "Agent executing Joey-approved release $CANDIDATE_SHA; approval: $APPROVAL_REFERENCE" \
  '{environment_ids: [$environment_id], state: "approved", comment: $comment}' |
  release_gh api --method POST --input - --silent \
    "repos/$REPOSITORY/actions/runs/$RUN_ID/pending_deployments"
release_gh run watch "$RUN_ID" --repo "$REPOSITORY" --exit-status
```

For a failure after publication may have begun, inspect npm and every later channel before another dispatch. The registry visibility check currently waits about 30 seconds; a successful npm publish may become visible later. npm metadata can appear before the ordinary tarball URL stops returning a cached 404 (observed negative-cache max-age: 300 seconds). A cache-busted successful download is not sufficient readiness for this workflow: require the unmodified `scripts/release-inventory.sh <promotion-directory> <output.json>` to succeed and show the exact certified tarball hash before retrying. Then use the same four candidate inputs with `PROMOTION_MODE=recover`, dispatch once, and repeat identity checks and approval for that new exact run. A credential failure before publication is not a reason to use recover mode. See [Recovery after main advances](#recovery-after-main-advances) for terminal conflicts and forward-only rules.

After success, verify all channels independently: npm version and expected dist-tag; downloaded npm tarball SHA-256, provenance and source identity against the certified manifest; Git tag's peeled commit; GitHub release target and every asset against `SHA256SUMS`; and the Homebrew formula's version, candidate SHA, fingerprint and binary hashes. A green workflow alone is not the delivery record. Preserve sanitized evidence in the maintenance run log and report incomplete channels as incomplete.

The operator token intentionally allows an agent to supply the environment approval as `jkudish`; GitHub does not distinguish that call from Joey clicking. Keep explicit per-release authorization as the human decision gate. A permanent credential grants technical capability, not standing publishing authority.

## Required repository setup

Before publication, a repository administrator must create the `release` environment in **Settings → Environments** and configure:

- at least one required reviewer; and
- deployment restricted to protected branches; and
- an environment secret named `NPM_TOKEN`, containing a granular npm token with write access to `librarium` and bypass-2FA enabled; and
- an environment secret named `HOMEBREW_TAP_TOKEN`, containing a GitHub credential scoped to `jkudish/homebrew-tap` with repository Contents read/write permission and permission under that repository's branch rules to push the one forward-only formula commit directly to `main`.

`NPM_TOKEN` is exposed only to the recovery step that restores an expected npm dist-tag. This workflow uses npm trusted-publishing OIDC for `npm publish` and explicitly requires traditional token authentication for its `npm dist-tag add` recovery step; the operator's GitHub token cannot substitute for it. `HOMEBREW_TAP_TOKEN` is exposed to a read-only readiness check before publication and to the final Homebrew publication step. The workflow performs a read-only GitHub API preflight and fails before candidate checkout when either environment-protection rule is absent. Merely writing `environment: release` in workflow YAML does not protect it: GitHub can auto-create an unprotected environment. Repository settings and secrets are therefore required publication boundaries and are not configured by this repository.

## Read-only readiness before dispatch

Establish credential readiness during administrator setup and inspect channel identity before each promotion. Secret-name listing and direct Homebrew-token inspection below are administrator checks, not additional permissions for the delegated operator token. An operator who cannot read environment secrets must record that limit, rely on the previously configured environment and the workflow's pre-publication Homebrew check, and never claim to have inspected private credentials. Missing or expired credentials require administrator intervention, not broader operator permissions. `NPM_TOKEN` readiness remains unproven until a dist-tag recovery needs it.

npm publication is the first irreversible write. The workflow checks that the Homebrew credential is present,
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
