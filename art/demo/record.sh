#!/usr/bin/env bash
# Record the README demo GIF deterministically and for free.
#
# Sets up an isolated HOME + a `librarium` shim on PATH that runs the real built
# CLI with globalThis.fetch stubbed (art/demo/demo-run.mjs). The typed command
# in demo.tape ("librarium run ...") therefore reads exactly like a real run --
# because it IS one, minus the network. Produces art/demo.gif.
#
# Requires: vhs (brew install vhs), a prior `npm run build`.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEMO_DIR/../.." && pwd)"

if ! command -v vhs >/dev/null 2>&1; then
  echo "vhs not found. Install with: brew install vhs" >&2
  exit 1
fi
if [ ! -f "$REPO_DIR/dist/cli.js" ]; then
  echo "dist/cli.js missing. Run: npm run build" >&2
  exit 1
fi

DEMO_HOME="$(mktemp -d "${TMPDIR:-/tmp}/librarium-demo.XXXXXX")"
SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/librarium-shim.XXXXXX")"
trap 'rm -rf "$DEMO_HOME" "$SHIM_DIR"' EXIT

# Seed the isolated librarium config (real provider ids, demo group).
node "$DEMO_DIR/build-demo-home.mjs" "$DEMO_HOME" >/dev/null

# `librarium` shim -> the fetch-stubbed real CLI driver.
cat >"$SHIM_DIR/librarium" <<SHIM
#!/usr/bin/env bash
exec node "$DEMO_DIR/demo-run.mjs" "\$@"
SHIM
chmod +x "$SHIM_DIR/librarium"

export DEMO_HOME
export PATH="$SHIM_DIR:$PATH"

cd "$DEMO_DIR"
vhs demo.tape
echo "Wrote $REPO_DIR/art/demo.gif"
ls -lh "$REPO_DIR/art/demo.gif"
