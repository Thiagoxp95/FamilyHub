# FamilyHub Releases & Auto-Update

FamilyHub is distributed **privately** (AirDrop / direct install to the kitchen
Mac). It is **not notarized** and uses **no Apple Developer account**. Updates are
delivered through **GitHub Releases** and applied automatically by
[`electron-updater`](https://www.electron.build/auto-update).

## How updates work

1. You build + publish a new version from your dev machine (`npm run release`).
2. The build is signed with a **reusable self-signed certificate**
   ("FamilyHub Self Signed").
3. The kitchen Mac runs an installed build. On launch — and every 6 hours —
   it checks the GitHub release feed, downloads a newer version in the
   background, and installs it on next quit/relaunch. **No clicks required.**

### Why the self-signed certificate is mandatory

macOS keys two things to the app's code-signing identity, and both require it to
be **stable across builds**:

- **Auto-update (Squirrel.Mac)** validates that the new build satisfies the
  running build's code requirement. Ad-hoc signing produces a *different* hash
  every build, so Squirrel rejects the update with
  `SQRLCodeSignatureErrorDomain … did not pass validation`.
- **TCC permissions** (Microphone for the wake word, Calendar/Reminders
  automation) are granted to a specific signing identity. With ad-hoc builds the
  identity changes every release, so permissions would reset on every update.

A single reused self-signed cert gives a **stable designated requirement**
(`identifier "com.familyhub.app" and certificate root = H"…"`), which fixes both.
Notarization is **not** needed for either.

## One-time setup — build machine

```bash
cd apps/electron
npm run setup-signing      # creates + trusts the cert (one macOS auth prompt)
```

The certificate lives in `~/.familyhub/codesign/` (outside the repo).

> ⚠️ **Never regenerate the certificate after shipping a build.** A new cert
> changes the signing identity, which breaks auto-update and resets the kitchen
> Mac's mic/calendar permissions. **Back up `~/.familyhub/codesign/`.**

## Cutting a release

```bash
cd apps/electron
npm version patch --no-git-tag-version    # 0.0.4 -> 0.0.5 (or edit package.json)
npm run release                           # build, sign, publish to GitHub
```

`npm run release` builds the signed mac arm64 dmg + zip, publishes them with the
update manifest (`latest-mac.yml`) to a GitHub Release, then **verifies all three
assets uploaded** and re-uploads any that GitHub dropped (its large-asset uploads
are occasionally flaky/eventually-consistent).

The release uploads ~800 MB and can take several minutes. Updates the kitchen Mac
*downloads* are **differential** (electron-updater diffs against the previous
build via blockmaps), so day-to-day updates pull only the changed blocks — small.

## One-time setup — kitchen Mac

1. AirDrop the latest `FamilyHub-<version>-arm64.dmg`.
2. Open the dmg, drag **FamilyHub** to `/Applications`.
3. **First launch only** — because the app isn't notarized, Gatekeeper blocks it
   once. Clear the quarantine flag (do this while you still have a keyboard
   attached during setup):
   ```bash
   xattr -dr com.apple.quarantine /Applications/FamilyHub.app
   ```
   (or right-click the app → **Open** → **Open** once).
4. Grant Microphone + Calendar/Reminders permissions when prompted.

After this, every future update installs silently — the running app replaces
itself and relaunches, with **no Gatekeeper prompt and no permission reset**
(thanks to the stable signing identity).

## Known limitation — voice sidecar Python

The Python voice sidecar's virtualenv (`sidecar/.venv`) is intentionally **not
bundled** (it's large and path-specific). On the dev machine the app falls back
to the source checkout's `.venv`; **on the kitchen Mac there is no source
checkout**, so the wake-word / local-transcription features need a Python
interpreter + `sidecar/requirements.txt` installed separately, or
`FAMILYHUB_SIDECAR_PYTHON` pointed at one. The dashboard (calendar, weather,
reminders, notes) works without it. Bundling a self-contained Python runtime is a
separate follow-up.
