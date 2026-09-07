#!/usr/bin/env bash
set -euo pipefail

# Orbit — Linux installer
#
#   curl -fsSL https://orbit.fragmentslabs.com/install.sh | bash
#
# Behavior:
#   1. On apt-based distros (Debian/Ubuntu): downloads the latest .deb and
#      installs it as a native package (app menu entry + icon), asking for the
#      admin password via `sudo` when possible, else via the graphical `pkexec`
#      dialog, else by printing the command for the user to run.
#   2. Otherwise: falls back to the portable AppImage in ~/.local/bin (run as
#      `orbit`).
#
# Environment:
#   ORBIT_BASE_URL      download base (default: https://orbit.fragmentslabs.com)
#   ORBIT_REPO          GitHub repo for the fallback (default: FragmentsLabs/Orbit)
#   ORBIT_INSTALL_DIR   AppImage install directory (default: ~/.local/bin)

REPO="${ORBIT_REPO:-FragmentsLabs/Orbit}"
BASE_URL="${ORBIT_BASE_URL:-https://orbit.fragmentslabs.com}"
GITHUB_URL="https://github.com/${REPO}/releases/latest/download"
INSTALL_DIR="${ORBIT_INSTALL_DIR:-$HOME/.local/bin}"
BIN_PATH="${INSTALL_DIR}/orbit"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

# --- download helper: branded domain first, GitHub as fallback ----------------
download_file() { # $1 = remote file name, $2 = local path
  for url in "${BASE_URL}/downloads/$1" "${GITHUB_URL}/$1"; do
    if curl -fsSL -o "$2" "$url"; then
      return 0
    fi
  done
  return 1
}

# --- architecture -------------------------------------------------------------
case "$(uname -m)" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64)
    info "Detected arm64. Orbit currently ships x86_64 builds only."
    info "Run it via an emulator, or build from source."
    ARCH="x86_64"
    ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac

# --- 1) apt-based system: install the native .deb ----------------------------
if command -v apt-get >/dev/null 2>&1; then
  info "apt detected — installing Orbit as a native package (.deb) with app menu icon."

  # The .deb artifact has a stable name (artifactName template in
  # electron-builder.json5: ${productName}-Linux-${arch}.${ext}), so the
  # releases/latest URL always resolves to the newest build.
  DEB="Orbit-Linux-amd64.deb"
  TMP_DEB="$(mktemp --suffix=.deb)"

  info "Downloading ${DEB}…"
  if download_file "$DEB" "$TMP_DEB"; then
    if sudo -n true 2>/dev/null; then
      info "Installing via sudo (no password needed)…"
      sudo apt-get install -y "$TMP_DEB"
    elif command -v pkexec >/dev/null 2>&1 && [ -n "${DISPLAY:-${WAYLAND_DISPLAY:-}}" ]; then
      info "Graphical password prompt (pkexec)…"
      pkexec apt-get install -y "$TMP_DEB"
    else
      warn "Admin privileges are required. Run the command below to finish:"
      warn "  sudo apt-get install -y ${TMP_DEB}"
      rm -f "$TMP_DEB"
      exit 1
    fi

    rm -f "$TMP_DEB"
    info "Orbit installed! Look for 'Orbit' in your applications menu."
    info "Uninstall with: sudo apt-get remove orbit"
    exit 0
  else
    warn "Could not download ${DEB} — falling back to the portable AppImage."
  fi
  rm -f "$TMP_DEB"
fi

# --- 2) no apt / deb failed: portable AppImage -------------------------------
info "Using portable AppImage install (${BIN_PATH})"

mkdir -p "$INSTALL_DIR"
ASSET="Orbit-Linux-${ARCH}.AppImage"

info "Downloading ${ASSET}…"
if ! download_file "$ASSET" "$BIN_PATH"; then
  die "Could not download ${ASSET} from ${BASE_URL} nor ${GITHUB_URL}."
fi

chmod +x "$BIN_PATH"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    warn "$INSTALL_DIR is not in your PATH. Add it to your shell profile:"
    warn "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

info "Installed Orbit to ${BIN_PATH}"
info "Run 'orbit' to start. Uninstall with: rm ${BIN_PATH}"