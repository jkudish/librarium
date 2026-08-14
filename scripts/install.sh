#!/bin/sh
# install.sh — Install librarium standalone binary
#
# Public release:
#   curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh
#
# Exact local release candidate:
#   LIBRARIUM_CANDIDATE=/path/to/librarium-linux-x64 \
#   LIBRARIUM_SHA256=<64-lowercase-hex> \
#   LIBRARIUM_VERSION=2.0.0-rc.1 \
#   LIBRARIUM_INSTALL_DIR=/path/to/bin sh scripts/install.sh
#
# Environment variables:
#   LIBRARIUM_VERSION       — Specific version to install (default: latest)
#   LIBRARIUM_INSTALL_DIR   — Installation directory (default: /usr/local/bin)
#   LIBRARIUM_CANDIDATE     — Exact local candidate binary (requires the next two)
#   LIBRARIUM_SHA256        — Expected SHA-256 for the local candidate

set -eu

REPO="jkudish/librarium"
INSTALL_DIR="${LIBRARIUM_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="librarium"
LOCAL_CANDIDATE="${LIBRARIUM_CANDIDATE:-}"
EXPECTED_SHA256="${LIBRARIUM_SHA256:-}"
STAGE_FILE=""
BACKUP_FILE=""
DOWNLOAD_FILE=""
DESTINATION="${INSTALL_DIR}/${BINARY_NAME}"
REPLACED=0
HAD_PRIOR=0

detect_os() {
  case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

get_latest_version() {
  url="https://api.github.com/repos/${REPO}/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    tag=$(curl -fsSL "$url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"//;s/".*//')
  elif command -v wget >/dev/null 2>&1; then
    tag=$(wget -qO- "$url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"//;s/".*//')
  else
    echo "Error: curl or wget required" >&2
    exit 1
  fi
  echo "${tag#v}"
}

download() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$destination" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  else
    echo "Error: curl or wget required" >&2
    exit 1
  fi
}

sha256_file() {
  path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | sed 's/^.*= //'
  else
    echo "Error: sha256sum, shasum, or openssl is required" >&2
    exit 1
  fi
}

privileged() {
  if [ -w "$INSTALL_DIR" ]; then
    "$@"
  else
    sudo "$@"
  fi
}

rollback() {
  if [ "$REPLACED" -eq 1 ]; then
    if [ "$HAD_PRIOR" -eq 1 ] && [ -n "$BACKUP_FILE" ]; then
      if ! privileged mv -f "$BACKUP_FILE" "$DESTINATION"; then
        echo "Error: automatic rollback failed; prior install remains at $BACKUP_FILE" >&2
        return 1
      fi
      BACKUP_FILE=""
    else
      if ! privileged rm -f "$DESTINATION"; then
        echo "Error: automatic rollback failed to remove the failed install" >&2
        return 1
      fi
    fi
    REPLACED=0
  fi
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    if ! rollback; then
      status=1
    fi
  fi
  if [ -n "$STAGE_FILE" ]; then
    privileged rm -f "$STAGE_FILE" 2>/dev/null || true
  fi
  if [ -n "$DOWNLOAD_FILE" ]; then
    rm -f "$DOWNLOAD_FILE" 2>/dev/null || true
  fi
  if [ -n "$BACKUP_FILE" ] && [ "$REPLACED" -eq 0 ]; then
    privileged rm -f "$BACKUP_FILE" 2>/dev/null || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

validate_local_candidate() {
  if [ -z "$LOCAL_CANDIDATE" ] && [ -z "$EXPECTED_SHA256" ]; then
    return
  fi
  if [ -z "$LOCAL_CANDIDATE" ] || [ -z "$EXPECTED_SHA256" ] || [ -z "${LIBRARIUM_VERSION:-}" ]; then
    echo "Error: local candidate installs require LIBRARIUM_CANDIDATE, LIBRARIUM_SHA256, and LIBRARIUM_VERSION" >&2
    exit 1
  fi
  if [ -L "$LOCAL_CANDIDATE" ] || [ ! -f "$LOCAL_CANDIDATE" ]; then
    echo "Error: LIBRARIUM_CANDIDATE must be an existing regular file, not a symlink" >&2
    exit 1
  fi
  case "$EXPECTED_SHA256" in
    *[!0-9a-f]*|'')
      echo "Error: LIBRARIUM_SHA256 must be exactly 64 lowercase hexadecimal characters" >&2
      exit 1
      ;;
  esac
  if [ "${#EXPECTED_SHA256}" -ne 64 ]; then
    echo "Error: LIBRARIUM_SHA256 must be exactly 64 lowercase hexadecimal characters" >&2
    exit 1
  fi
  if ! printf '%s\n' "$LIBRARIUM_VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.[1-9][0-9]*$'; then
    echo "Error: local candidate version must use strict X.Y.Z-rc.N syntax" >&2
    exit 1
  fi
}

main() {
  OS=$(detect_os)
  ARCH=$(detect_arch)

  if [ "$OS" = "unsupported" ]; then
    echo "Error: Unsupported operating system: $(uname -s)" >&2
    exit 1
  fi
  if [ "$ARCH" = "unsupported" ]; then
    echo "Error: Unsupported architecture: $(uname -m)" >&2
    exit 1
  fi
  if [ "$OS" = "windows" ]; then
    echo "Error: Windows is not supported by this installer." >&2
    echo "Download the binary manually from https://github.com/${REPO}/releases" >&2
    exit 1
  fi

  validate_local_candidate

  VERSION="${LIBRARIUM_VERSION:-}"
  if [ -z "$VERSION" ]; then
    echo "Fetching latest version..."
    VERSION=$(get_latest_version)
    if [ -z "$VERSION" ]; then
      echo "Error: Could not determine latest version" >&2
      exit 1
    fi
  fi

  if [ ! -d "$INSTALL_DIR" ]; then
    echo "Error: Installation directory does not exist: $INSTALL_DIR" >&2
    exit 1
  fi

  ASSET_NAME="${BINARY_NAME}-${OS}-${ARCH}"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET_NAME}"
  STAGE_FILE="${INSTALL_DIR}/.${BINARY_NAME}.stage.$$"
  BACKUP_FILE="${INSTALL_DIR}/.${BINARY_NAME}.backup.$$"
  if [ -e "$STAGE_FILE" ] || [ -L "$STAGE_FILE" ] || [ -e "$BACKUP_FILE" ] || [ -L "$BACKUP_FILE" ]; then
    echo "Error: Refusing to reuse an existing installer transaction path" >&2
    exit 1
  fi
  if [ -L "$DESTINATION" ]; then
    echo "Error: Refusing to replace a symlink destination" >&2
    exit 1
  fi

  echo "Installing librarium v${VERSION} (${OS}/${ARCH})..."
  if [ -n "$LOCAL_CANDIDATE" ]; then
    echo "  From: local candidate ${LOCAL_CANDIDATE}"
    privileged cp "$LOCAL_CANDIDATE" "$STAGE_FILE"
  else
    echo "  From: ${DOWNLOAD_URL}"
    DOWNLOAD_FILE=$(mktemp)
    download "$DOWNLOAD_URL" "$DOWNLOAD_FILE"
    privileged cp "$DOWNLOAD_FILE" "$STAGE_FILE"
    rm -f "$DOWNLOAD_FILE"
    DOWNLOAD_FILE=""
  fi
  echo "  To:   ${DESTINATION}"

  if [ -n "$LOCAL_CANDIDATE" ]; then
    actual_sha256=$(sha256_file "$STAGE_FILE")
    if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
      echo "Error: Candidate checksum mismatch" >&2
      exit 1
    fi
  fi

  privileged chmod 755 "$STAGE_FILE"
  staged_version=$("$STAGE_FILE" --version 2>/dev/null || true)
  if [ "$staged_version" != "$VERSION" ]; then
    echo "Error: Candidate version mismatch: expected $VERSION, got ${staged_version:-<none>}" >&2
    exit 1
  fi

  if [ -e "$DESTINATION" ] || [ -L "$DESTINATION" ]; then
    privileged cp -p "$DESTINATION" "$BACKUP_FILE"
    HAD_PRIOR=1
  fi

  privileged mv -f "$STAGE_FILE" "$DESTINATION"
  STAGE_FILE=""
  REPLACED=1

  installed_version=$("$DESTINATION" --version 2>/dev/null || true)
  if [ "$installed_version" != "$VERSION" ]; then
    echo "Error: Installed binary failed post-move verification" >&2
    exit 1
  fi

  if [ "$HAD_PRIOR" -eq 1 ]; then
    privileged rm -f "$BACKUP_FILE"
  fi
  BACKUP_FILE=""
  REPLACED=0

  echo ""
  echo "librarium v${VERSION} installed successfully!"
  echo "Run 'librarium --version' to verify."
}

main
