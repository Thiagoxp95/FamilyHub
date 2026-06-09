#!/usr/bin/env bash
#
# Ship a new FamilyHub build to the kitchen Mac in one step:
#   1. bump the patch version (0.0.6 -> 0.0.7)
#   2. build + sign + publish to GitHub (installed builds auto-update)
#   3. drop the fresh dmg on your Desktop and print its path for AirDrop
#
# Run it:   cd apps/electron && npm run ship
#    or:    bash apps/electron/scripts/ship.sh   (from anywhere)
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # apps/electron

echo ">>> Bumping patch version..."
npm version patch --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
echo ">>> New version: ${VERSION}"

# build + sign + publish (+ asset verification)
bash scripts/release.sh

# Copy the dmg to the Desktop for easy AirDrop.
DMG="release/FamilyHub-${VERSION}-arm64.dmg"
if [ -f "$DMG" ]; then
  cp "$DMG" "$HOME/Desktop/"
  echo ""
  echo "=========================================================="
  echo " ✅ Shipped v${VERSION}."
  echo " AirDrop this dmg to the kitchen Mac:"
  echo "     $HOME/Desktop/FamilyHub-${VERSION}-arm64.dmg"
  echo " (already-installed kitchen builds will auto-update — no need to re-AirDrop)"
  echo "=========================================================="
else
  echo "WARNING: expected dmg not found at $DMG"
  exit 1
fi
