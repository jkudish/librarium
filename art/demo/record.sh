#!/usr/bin/env bash
# Record the README demo GIF through the real, network-denied fixture command.
# Requires vhs and a prior `npm run build`. It uses no credentials, provider
# configuration, paid API call, or mocked network response.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEMO_DIR/../.." && pwd)"

if [ ! -f "$REPO_DIR/dist/cli.js" ]; then
  echo "dist/cli.js missing. Run: npm run build" >&2
  exit 1
fi

if ! command -v vhs >/dev/null 2>&1; then
  echo "VHS is unavailable; rendering the fixture output with ImageMagick." >&2
  node "$DEMO_DIR/render.mjs"
  exit 0
fi

SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/librarium-shim.XXXXXX")"
trap 'rm -rf "$SHIM_DIR"' EXIT

cat >"$SHIM_DIR/librarium" <<SHIM
#!/usr/bin/env bash
exec node "$DEMO_DIR/demo-run.mjs"
SHIM
chmod +x "$SHIM_DIR/librarium"

export PATH="$SHIM_DIR:$PATH"
cd "$DEMO_DIR"
if vhs demo.tape; then
  echo "Wrote $REPO_DIR/art/demo.gif"
  ls -lh "$REPO_DIR/art/demo.gif"
else
  echo "VHS is unavailable; rendering the same fixture output with ImageMagick." >&2
  node render.mjs
fi
