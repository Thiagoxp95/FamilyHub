#!/usr/bin/env bash
#
# One-time signing setup for the BUILD machine.
#
# FamilyHub is distributed privately (AirDrop / direct install), so it is NOT
# notarized and uses no Apple Developer account. macOS auto-update (Squirrel.Mac)
# and TCC permissions (microphone, calendar/reminders automation) both key off
# the app's code-signing identity, which MUST be STABLE across builds. We achieve
# that with a single reusable self-signed code-signing certificate.
#
# This script is idempotent. It:
#   1. Creates the self-signed cert (once) in ~/.familyhub/codesign/
#   2. Imports it into a dedicated build keychain
#   3. Trusts it for code signing (ONE macOS auth prompt the first time)
#
# DO NOT regenerate the cert once you've shipped a build — a new cert changes the
# signing identity, which breaks auto-update (Squirrel rejects the new build) and
# resets the kitchen Mac's mic/calendar permissions. Back up ~/.familyhub/codesign/.
#
set -euo pipefail

CDIR="$HOME/.familyhub/codesign"
P12="$CDIR/familyhub-signing.p12"
CRT="$CDIR/familyhub-signing.crt"
KEY="$CDIR/familyhub-signing.key"
PWFILE="$CDIR/p12-password.txt"
CONF="$CDIR/cert.conf"
CN="FamilyHub Self Signed"
KEYCHAIN="$HOME/Library/Keychains/familyhub-build.keychain-db"
KEYCHAIN_PASS="fhbuild"

mkdir -p "$CDIR"

# --- 1. Certificate (create once) ------------------------------------------
if [ ! -f "$P12" ]; then
  echo ">>> Creating self-signed code-signing certificate..."
  [ -f "$PWFILE" ] || echo "familyhub-signing" > "$PWFILE"
  PW="$(cat "$PWFILE")"
  cat > "$CONF" <<'EOF'
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = FamilyHub Self Signed
O = FamilyHub
[ v3 ]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
  openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CRT" -days 3650 -nodes -config "$CONF"
  openssl pkcs12 -export -inkey "$KEY" -in "$CRT" -out "$P12" -name "$CN" -passout pass:"$PW"
  chmod 600 "$P12" "$KEY" "$PWFILE"
else
  echo ">>> Reusing existing certificate at $P12"
fi
PW="$(cat "$PWFILE")"

# --- 2. Dedicated build keychain -------------------------------------------
echo ">>> (Re)creating build keychain $KEYCHAIN"
security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"            # no auto-lock
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
security import "$P12" -k "$KEYCHAIN" -P "$PW" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASS" "$KEYCHAIN" >/dev/null 2>&1
# Add to the user search list so codesign/electron-builder can find the identity.
EXISTING="$(security list-keychains -d user | sed 's/[" ]//g' | tr '\n' ' ')"
security list-keychains -d user -s "$KEYCHAIN" $EXISTING >/dev/null 2>&1

# --- 3. Trust the cert for code signing (prompts once) ---------------------
if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "$CN"; then
  echo ">>> Certificate already trusted for code signing."
else
  echo ">>> Approve the macOS dialog to trust the cert for code signing (one time)..."
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$CRT"
fi

echo ">>> Verifying..."
security find-identity -v -p codesigning "$KEYCHAIN" | grep "$CN" && echo ">>> Signing is ready."
