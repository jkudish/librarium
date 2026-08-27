#!/bin/bash
# Read-only inventory for immutable release promotion. This script never writes
# to Git, npm, GitHub, or Homebrew. Every lookup failure is fatal unless the
# provider authoritatively reports that the exact version/tag/release is absent.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: release-inventory.sh <promotion-directory> <output.json>" >&2
  exit 2
fi

PROMOTION_ROOT="$1"
OUTPUT="$2"
SPEC="$PROMOTION_ROOT/promotion.json"
VERSION="$(jq -er '.candidate.version' "$SPEC")"
TAG="$(jq -er '.tag' "$SPEC")"
REPOSITORY="$(jq -er '.repository' "$SPEC")"
EXPECTED_SHA="$(jq -er '.candidate.git_sha' "$SPEC")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sha256_json() {
  local path="$1"
  printf '"sha256:%s"' "$(sha256sum "$path" | awk '{print $1}')"
}

BRANCH_SHA="$(git ls-remote --exit-code "https://github.com/${REPOSITORY}.git" refs/heads/main | awk '{print $1}')"
test -n "$BRANCH_SHA"

TAG_ROWS="$(git ls-remote "https://github.com/${REPOSITORY}.git" "refs/tags/${TAG}" "refs/tags/${TAG}^{}")"
if [ -z "$TAG_ROWS" ]; then
  TAG_SHA=null
else
  TAG_SHA_VALUE="$(printf '%s\n' "$TAG_ROWS" | awk '$2 ~ /\^\{\}$/ {print $1; found=1} END {if (!found && NR == 1) print $1}')"
  test -n "$TAG_SHA_VALUE"
  TAG_SHA="\"$TAG_SHA_VALUE\""
fi

REGISTRY_STATUS="$(curl -sS --retry 3 --retry-all-errors -o "$TMP/npm.json" -w '%{http_code}' "https://registry.npmjs.org/librarium")"
test "$REGISTRY_STATUS" = 200
NPM_TARBALL="$(jq -er --arg version "$VERSION" '.versions[$version].dist.tarball // empty' "$TMP/npm.json" || true)"
if [ -z "$NPM_TARBALL" ]; then
  NPM_SHA=null
else
  curl -fsS --retry 3 --retry-all-errors -o "$TMP/npm.tgz" "$NPM_TARBALL"
  NPM_SHA="$(sha256_json "$TMP/npm.tgz")"
fi

AUTH_HEADER="Authorization: Bearer ${GH_TOKEN:?GH_TOKEN is required for GitHub inventory}"
RELEASE_STATUS="$(curl -sS --retry 3 --retry-all-errors -H "$AUTH_HEADER" -H 'Accept: application/vnd.github+json' -o "$TMP/release.json" -w '%{http_code}' "https://api.github.com/repos/${REPOSITORY}/releases/tags/${TAG}")"
if [ "$RELEASE_STATUS" = 404 ]; then
  GITHUB_RELEASE=null
else
  test "$RELEASE_STATUS" = 200
  TARGET="$(jq -er '.target_commitish' "$TMP/release.json")"
  test "$(jq '[.assets[].name] | length == (unique | length)' "$TMP/release.json")" = true
  printf '{}\n' > "$TMP/assets.json"
  while IFS=$'\t' read -r name url; do
    test -n "$name"
    curl -fsS --retry 3 --retry-all-errors -H "$AUTH_HEADER" -H 'Accept: application/octet-stream' -o "$TMP/asset" "$url"
    digest="sha256:$(sha256sum "$TMP/asset" | awk '{print $1}')"
    jq --arg name "$name" --arg digest "$digest" '. + {($name): $digest}' "$TMP/assets.json" > "$TMP/assets.next"
    mv "$TMP/assets.next" "$TMP/assets.json"
  done < <(jq -r '.assets[] | [.name, .url] | @tsv' "$TMP/release.json")
  GITHUB_RELEASE="$(jq -cn --arg target "$TARGET" --slurpfile assets "$TMP/assets.json" '{target_sha:$target,assets:$assets[0]}')"
fi

git clone --quiet --depth 1 https://github.com/jkudish/homebrew-tap.git "$TMP/tap"
FORMULA="$TMP/tap/Formula/librarium.rb"
if [ -e "$FORMULA" ]; then
  test -f "$FORMULA"
  FORMULA_VERSION="$(sed -n 's/^[[:space:]]*version "\([^"]*\)".*/\1/p' "$FORMULA")"
  test -n "$FORMULA_VERSION"
  HOMEBREW_VERSION="\"$FORMULA_VERSION\""
  if [ "$FORMULA_VERSION" = "$VERSION" ]; then
    HOMEBREW_SHA="$(sha256_json "$FORMULA")"
  else
    HOMEBREW_SHA=null
  fi
else
  HOMEBREW_VERSION=null
  HOMEBREW_SHA=null
fi

jq -n \
  --arg branch "$BRANCH_SHA" \
  --argjson tag "$TAG_SHA" \
  --argjson npm "$NPM_SHA" \
  --argjson release "$GITHUB_RELEASE" \
  --argjson homebrew_version "$HOMEBREW_VERSION" \
  --argjson homebrew "$HOMEBREW_SHA" \
  '{branch_sha:$branch,tag_sha:$tag,npm_sha256:$npm,github_release:$release,homebrew_version:$homebrew_version,homebrew_formula_sha256:$homebrew}' > "$OUTPUT"

# Refuse a surprising branch value here as well as in reconciliation so no
# provider inventory can be mistaken for authority.
test "$BRANCH_SHA" = "$EXPECTED_SHA"
