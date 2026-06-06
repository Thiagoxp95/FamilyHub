#!/usr/bin/env bash
# Compiles the Swift EventKit helper into apps/electron/resources/fh-eventkit
# with an embedded Info.plist (TCC usage strings) and an ad-hoc hardened-runtime
# signature. macOS-only; no-op-friendly if swiftc is missing.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$DIR/../resources"
OUT="$OUT_DIR/fh-eventkit"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build:native: swiftc not found — skipping (macOS + Xcode CLT required)."
  exit 0
fi

mkdir -p "$OUT_DIR"
swiftc "$DIR/fh-eventkit.swift" -O -o "$OUT" \
  -framework EventKit -framework Foundation -framework AppKit \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist"
codesign --force --options runtime --identifier com.familyhub.eventkit --sign - "$OUT"
echo "build:native: wrote $OUT"
