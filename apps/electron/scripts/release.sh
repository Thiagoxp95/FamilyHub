#!/usr/bin/env bash
#
# Release FamilyHub to GitHub Releases.
#
# Builds the mac arm64 app, signs it with the reusable self-signed
# "FamilyHub Self Signed" certificate, and publishes the dmg + zip + update
# manifest to GitHub. The kitchen Mac (running an installed build) auto-updates
# from these releases via electron-updater — no notarization, no Apple account.
#
# Usage:
#   1. Bump the version:   npm version patch --no-git-tag-version   (or edit package.json)
#   2. Release:            npm run release
#
# One-time machine setup is in scripts/setup-signing.sh (creates + trusts the cert).
#
set -euo pipefail

REPO="Thiagoxp95/FamilyHub"
KEYCHAIN="$HOME/Library/Keychains/familyhub-build.keychain-db"
KEYCHAIN_PASS="fhbuild"

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # apps/electron

# --- Preconditions ---------------------------------------------------------
command -v gh >/dev/null   || { echo "ERROR: gh CLI not found (brew install gh)"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated (gh auth login)"; exit 1; }
[ -f "$KEYCHAIN" ] || { echo "ERROR: signing keychain missing. Run: bash scripts/setup-signing.sh"; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
echo ">>> Releasing FamilyHub ${TAG}"

# --- Signing + publish env -------------------------------------------------
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
export CSC_KEYCHAIN="$KEYCHAIN"
export CSC_IDENTITY_AUTO_DISCOVERY=true
export GH_TOKEN="$(gh auth token)"

# --- Build + publish -------------------------------------------------------
echo ">>> Building and publishing (this uploads ~800MB; can take several minutes)..."
npm run release:mac:arm64

# --- Verify all required assets actually landed ----------------------------
# electron-builder's large-asset uploads to GitHub have been observed to be
# slow/eventually-consistent. Confirm the three assets the updater needs are
# present, and re-upload any that are missing from the local release/ dir.
REQUIRED=( "latest-mac.yml" "FamilyHub-${VERSION}-arm64.zip" "FamilyHub-${VERSION}-arm64.dmg" )
echo ">>> Verifying release assets..."
for attempt in 1 2 3 4 5; do
  ASSETS="$(gh api "repos/${REPO}/releases/tags/${TAG}" -q '.assets[].name' 2>/dev/null || true)"
  MISSING=()
  for r in "${REQUIRED[@]}"; do
    printf '%s\n' "$ASSETS" | grep -qx "$r" || MISSING+=( "$r" )
  done
  if [ "${#MISSING[@]}" -eq 0 ]; then
    echo ">>> All required assets present."
    break
  fi
  echo ">>> Missing (attempt ${attempt}/5): ${MISSING[*]} — re-uploading..."
  for m in "${MISSING[@]}"; do
    [ -f "release/${m}" ] && gh release upload "${TAG}" "release/${m}" --repo "${REPO}" --clobber || true
  done
  sleep 5
done

# --- Final report ----------------------------------------------------------
echo ">>> Release ${TAG} assets on GitHub:"
gh api "repos/${REPO}/releases/tags/${TAG}" -q '.assets[] | "  - \(.name)  (\(.size) bytes, \(.state))"'
echo ">>> Done. Installed kitchen builds will update on next launch or within ~6h."
