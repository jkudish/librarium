#!/bin/sh
# install.sh — Install librarium standalone binary
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh
#
# Environment variables:
#   LIBRARIUM_VERSION       — Specific version to install (default: latest)
#   LIBRARIUM_INSTALL_DIR   — Installation directory (default: /usr/local/bin)

set -e

REPO="jkudish/librarium"
INSTALL_DIR="${LIBRARIUM_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="librarium"

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unsupported" ;;
  esac
}

# Detect architecture
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

# Get latest version from GitHub Releases API (no jq needed)
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
  # Strip leading v
  echo "${tag#v}"
}

# Download a file
download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
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

  VERSION="${LIBRARIUM_VERSION:-}"
  if [ -z "$VERSION" ]; then
    echo "Fetching latest version..."
    VERSION=$(get_latest_version)
    if [ -z "$VERSION" ]; then
      echo "Error: Could not determine latest version" >&2
      exit 1
    fi
  fi

  ASSET_NAME="${BINARY_NAME}-${OS}-${ARCH}"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET_NAME}"

  echo "Installing librarium v${VERSION} (${OS}/${ARCH})..."
  echo "  From: ${DOWNLOAD_URL}"
  echo "  To:   ${INSTALL_DIR}/${BINARY_NAME}"

  # Create a temp file for download
  TMP_FILE=$(mktemp)
  trap 'rm -f "$TMP_FILE"' EXIT

  download "$DOWNLOAD_URL" "$TMP_FILE"

  # Make executable
  chmod +x "$TMP_FILE"

  # Verify the binary runs
  if ! "$TMP_FILE" --version >/dev/null 2>&1; then
    echo "Error: Downloaded binary failed verification" >&2
    exit 1
  fi

  # Move to install dir (may need sudo)
  if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    echo "  Note: ${INSTALL_DIR} requires elevated permissions"
    sudo mv "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
    sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
  fi

  echo ""
  echo "librarium v${VERSION} installed successfully!"
  echo "Run 'librarium --version' to verify."
}

main
