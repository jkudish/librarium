# Release candidate promotion recovery

This procedure is preregistered for a future promotion task. The release-candidate workflow does not publish, create or move tags, create GitHub releases, upload release assets, or write the Homebrew tap.

## Required recovery record

Before promotion, record these values from the verified candidate:

- full Git SHA and tree;
- committed `X.Y.Z-rc.N` version;
- candidate fingerprint;
- npm tarball path, size, and SHA-256;
- five SEA paths, sizes, and SHA-256 values;
- five live-validation record hashes;
- `candidate.json`, `SHA256SUMS`, and provenance hashes;
- promotion workflow revision and run URL.

Do not start or resume promotion when any value differs from the preregistered record.

## Forward-only rules

1. Stop at the first failed or uncertain publication step. Preserve the workflow logs and exact candidate bytes.
2. Inspect each distribution channel without changing it. Record the npm version and integrity, tag target, GitHub release and asset hashes, and Homebrew formula commit and checksums.
3. Never unpublish npm, force-move a tag, delete or overwrite a release asset, replace provenance, or rewrite Homebrew history.
4. Treat an existing object with the expected identity and bytes as complete. Resume only at the first later incomplete step. Do not republish it.
5. Treat an existing object with a conflicting SHA, integrity, version, tag target, asset body, checksum, or provenance subject as terminal for that version. Stop promotion. Commit the next `rc.N`, build a new candidate, and repeat certification.
6. If npm is complete but later channels are incomplete, keep the published package immutable and finish the matching tag, release, assets, and formula in order from the same candidate.
7. If the tag is correct but the release is incomplete, keep the tag. Add only absent release data whose expected name and checksum are not already present.
8. If all release assets are correct but Homebrew is incomplete, add a new forward Homebrew commit that references the already published immutable assets. Do not amend or force-push the tap.
9. If the promotion runner loses state, reconstruct it only from the preregistered recovery record and read-only channel inspection. Do not infer success from a previous step exit code.

## Resume gate

A future promotion task can resume only after two people review the recovery record and channel inventory. The resumed workflow must accept the frozen candidate SHA and hashes. It must reject a mutable version, rebuilt bytes, missing provenance, duplicate names, and conflicting remote state.

The release-candidate workflow is not promotion authority. Its artifacts are evidence for the later explicitly approved promotion task.
