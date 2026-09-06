#!/usr/bin/env bash
set -euo pipefail

# Orbit — Linux installer
# Downloads the latest Orbit AppImage (x86_64) from GitHub Releases through the
# branded download domain, with a direct GitHub fallback, and installs it to
# ~/.local/bin (or $ORBIT_INSTALL_DIR), so you can run it as `orbit`.
#
#   curl -fsSL https://orbit.fragmentslabs.com/install.sh | bash
#
# Environment:
#   ORBIT_INSTALL_DIR   install directory (default: ~/.local/bin)
#   ORBIT_BASE_URL      download base (default: https://orbit.fragmentslabs.com)
#   ORBIT_REPO          GitHub repo for the fallback (default: FragmentsLabs/Orbit)

REPO="${ORBIT_REPO:-FragmentsLabs/Orbit}"
BASE_URL="${ORBIT_BASE_URL:-https://orbit.fragmentslabs.com}"
GITHUB_URL="https://github.com/${REPO}/releases/latest/download"
INSTALL_DIR="${ORBIT_INSTALL_DIR:-$HOME/.local/bin}"
BIN_PATH="${INSTALL_DIR}/orbit"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

# --- architecture -------------------------------------------------------------
case "$(uname -m)" in
  x86_64|amd64) ASSET="Orbit-Linux-x64.AppImage" ;;
  aarch64|arm64)
    info "Detected arm64. Orbit currently ships x86_64 AppImages only."
    info "Run it via an emulator, or build from source."
    ASSET="Orbit-Linux-arm64.AppImage"
    ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac

# --- download: branded domain first, GitHub as fallback ----------------------
mkdir -p "$INSTALL_DIR"
download_url=""
for url in "${BASE_URL}/downloads/${ASSET}" "${GITHUB_URL}/${ASSET}"; do
  if curl -fsSL -o "$BIN_PATH" "$url"; then
    download_url="$url"
    break
  fi
done

if [ -z "$download_url" ]; then
  die "Could not download ${ASSET} from ${BASE_URL} nor ${GITHUB_URL}."
fi

chmod +x "$BIN_PATH"

# --- done ---------------------------------------------------------------------
info "Installed Orbit to ${BIN_PATH}"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    warn "$INSTALL_DIR is not in your PATH. Add it to your shell profile:"
    warn "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

info "Run 'orbit' to start. Uninstall with: rm ${BIN_PATH}"