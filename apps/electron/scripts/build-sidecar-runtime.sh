#!/usr/bin/env bash
#
# Build a self-contained, relocatable Python runtime for the wake-word sidecar so
# the packaged FamilyHub app runs the wake listener on ANY arm64 Mac with no
# system Python, no venv, and no internet at first launch.
#
# Produces sidecar/.runtime/ — a python-build-standalone CPython plus the
# pip-installed wake deps (livekit-wakeword ships its mel/embedding feature
# models inside the wheel). electron-builder ships it under
# Contents/Resources/sidecar/.runtime (see apps/electron/package.json
# extraResources) and signs it with the app's identity during the mac signing
# pass, so it satisfies the hardened runtime.
#
# Idempotent: a healthy existing runtime is reused. Force a clean rebuild with:
#   FORCE=1 bash scripts/build-sidecar-runtime.sh
#
set -euo pipefail

PY_VERSION="${PY_VERSION:-3.11}"
SIDECAR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../sidecar" && pwd)"
RUNTIME="$SIDECAR/.runtime"
PYBIN="$RUNTIME/bin/python3"
DEPS_CHECK='import livekit.wakeword, onnxruntime, numpy'

# --- Fast path: a healthy runtime already exists ---------------------------
if [ -z "${FORCE:-}" ] && [ -x "$PYBIN" ] && "$PYBIN" -c "$DEPS_CHECK" 2>/dev/null; then
  echo ">>> sidecar runtime already present and healthy ($("$PYBIN" --version 2>&1)). Skipping build."
else
  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME"

  # python-build-standalone publishes relocatable CPython builds. The
  # "install_only" arm64 macOS asset extracts to a top-level python/ dir whose
  # interpreter resolves its home relative to the executable — safe to move.
  echo ">>> Resolving python-build-standalone CPython ${PY_VERSION} (aarch64-apple-darwin)…"
  # The "+" in the version (e.g. cpython-3.11.15+20260602) is URL-encoded as %2B
  # in the asset URL — match either form. install_only (not _stripped) keeps
  # symbols; _stripped is excluded by anchoring on "install_only.tar.gz".
  ASSET_RE="cpython-${PY_VERSION}\.[0-9]+(%2B|\+)[0-9]+-aarch64-apple-darwin-install_only\.tar\.gz"
  ASSET_URL="$(curl -fsSL https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
    | grep -oE "https://[^\"]*${ASSET_RE}" | head -1)"
  if [ -z "$ASSET_URL" ]; then
    echo "ERROR: no CPython ${PY_VERSION} install_only arm64 asset found in the latest release." >&2
    echo "       Override the version with PY_VERSION=3.x or set ASSET_URL by hand." >&2
    exit 1
  fi

  echo ">>> Downloading ${ASSET_URL}"
  TARBALL="$RUNTIME/python.tar.gz"
  curl -fsSL -o "$TARBALL" "$ASSET_URL"
  tar -xzf "$TARBALL" -C "$RUNTIME"
  rm -f "$TARBALL"
  # Flatten python/ → .runtime/ so bin/python3 sits at $RUNTIME/bin/python3.
  shopt -s dotglob
  mv "$RUNTIME"/python/* "$RUNTIME"/
  rmdir "$RUNTIME"/python
  shopt -u dotglob

  echo ">>> Installing pinned wake deps into the runtime…"
  "$PYBIN" -m pip install --upgrade pip
  "$PYBIN" -m pip install --no-cache-dir -r "$SIDECAR/requirements.txt"

  # livekit-wakeword bundles its mel + speech-embedding feature models inside
  # the wheel, so the runtime is offline-complete after pip install — no
  # post-install model downloads.

  echo ">>> Pruning caches to shrink the bundle…"
  find "$RUNTIME" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
  find "$RUNTIME" -type d -name "test" -path "*/lib/python*/test" -prune -exec rm -rf {} + 2>/dev/null || true
fi

# The wake classifier (models/hey_james.onnx) is committed to the repo; the old
# stage-2 ASR verifier bundles (Moonshine/Whisper/Vosk, ~190 MB) are gone with
# the two-stage engine.
mkdir -p "$SIDECAR/models"

echo ">>> sidecar runtime ready: $PYBIN"
"$PYBIN" -c "$DEPS_CHECK; print('deps OK')"
