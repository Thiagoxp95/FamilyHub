# Slim Version Badge + Assistant Update Tools

**Date:** 2026-06-09
**Status:** Approved (design)
**Area:** `apps/electron` — renderer chrome + updater + assistant tooling

## Problem

The top-right "Check for updates" control is a glass, semi-transparent pill
(`.update-control` inside `.update-corner`, 40px min-height, rounded glass
background). It is visually heavy and out of place on the always-on kitchen
display. We want it replaced with a slim badge that sits in the thin titlebar
strip at the same height as the macOS window controls (the `hiddenInset`
traffic lights), showing the version number and an up-to-date checkmark, with a
click affordance to check for updates. Separately, the voice assistant (James)
should be able to manage updates by function tool calls.

## Goals

1. Replace the glass pill with a slim, low-chrome **version badge** in the
   top-right titlebar strip: `vX.Y.Z` + a state icon (✓ when up to date).
2. Clicking the badge checks for updates; when an update is downloaded, clicking
   installs and relaunches.
3. Expose the **current running app version** to the renderer (today only the
   *available/downloaded* version is carried in updater status).
4. Give the assistant three update tools: **check for updates**,
   **install + relaunch**, and **force download now**.

## Non-Goals

- No change to the background auto-update behaviour (launch check + 6h poll,
  `autoDownload = true`, silent auto-install + relaunch 60s after download).
- No read-only "report status" voice tool — the check tool already returns
  state + version, so James reports naturally from that.
- No factory reset / data reset. "Reset by itself" means install + relaunch.

## Current State (as built)

- `apps/electron/src/renderer/src/UpdateControl.tsx` — `UpdateControl` (IPC
  wiring) + `UpdateControlView` (switch over 7 states rendering glass pills with
  buttons: "Check for updates", "Restart", "Retry", etc.).
- `apps/electron/src/renderer/src/styles.css` — `.update-control`,
  `.update-control span/button`, `.update-control--ready/--error`, and the
  `position: fixed` `.update-corner` (top/right 18px) wrapper.
- `apps/electron/src/renderer/src/App.tsx:179` — renders `<UpdateControl />`
  inside `<div className="update-corner">`.
- `apps/electron/src/main/index.ts:30` — `titleBarStyle: "hiddenInset"` (traffic
  lights float top-left). Line 64-67: `registerAssistantIpc(dashboard)` runs
  *before* `registerUpdaterIpc(...)`.
- `apps/electron/src/main/updater.ts` — `createUpdaterController` exposes
  `checkNow()`, `getStatus()`, `installNow()`, `start()`. `UpdaterAdapter` wraps
  `autoUpdater` with `autoDownload`, `checkForUpdates`, `quitAndInstall`, `on`.
- `apps/electron/src/preload/index.ts:93` — `updater: { check, getStatus,
  install, onStatus }`. No `getVersion`.
- Assistant tools: declarations in `liveSession.ts` `conversationTools`
  (`functionDeclarations`), dispatched in `ipc.ts` `runTool` (switch over tool
  names), tool results returned to Gemini via `liveController.runToolCall`.

## Design

### 1. Expose the current app version

- `index.ts`: `ipcMain.handle("app:getVersion", () => app.getVersion())`.
- `preload/index.ts`: add `getVersion: () => ipcRenderer.invoke("app:getVersion")
  as Promise<string>` to the `familyHub` bridge (top-level, alongside `ping`).
- `vite-env.d.ts`: add `getVersion: () => Promise<string>` to `FamilyHubBridge`.

### 2. Version badge (rewrite `UpdateControl.tsx`)

`UpdateControl` keeps its IPC responsibilities and gains a `getVersion()` fetch
on mount (stored in state, defaults to empty string until resolved). It still
calls `getStatus()` once and subscribes to `updater:status`.

`UpdateControlView` is rewritten from a glass switch into a single
**morphing badge** — a `<button class="version-badge">` containing the version
text and a trailing state glyph:

| `status.state`        | Display              | aria-label / title       | onClick   |
|-----------------------|----------------------|--------------------------|-----------|
| `idle`, `not-available` | `v1.2.3 ✓`         | "Up to date — check now" | `onCheck` |
| `checking`            | `v1.2.3 ⟳` (spin)    | "Checking for updates…"  | none      |
| `available`           | `v1.2.3 ↓`           | "Update available"       | none      |
| `downloading`         | `v1.2.3 ↓ 42%`       | "Downloading update"     | none      |
| `downloaded`          | `v1.4.0 ↻`           | "Update ready — restart" | `onInstall` |
| `error`               | `v1.2.3 !`           | "Update failed — retry"  | `onCheck` |

- **Displayed version**: `status.version` when state is `available` /
  `downloading` / `downloaded` (the target version); otherwise the current app
  version from `getVersion()`.
- The badge is always a single clickable element. States with no action
  (`checking`, `available`, `downloading`) render as a disabled/non-interactive
  button (no pointer, click is a no-op).
- The spinner (`⟳`) animates via CSS; the `↓`/`↻`/`!`/`✓` are static glyphs.
- The component never returns `null` now — the badge is always present (it is
  passive chrome, not an alert). In an unpackaged/dev build the backend reports
  `idle`, so it shows `vX.Y.Z ✓` and a click is a harmless no-op check.

### 3. CSS (`styles.css`)

- Remove `.update-control`, `.update-control span`, `.update-control button`,
  `.update-control--ready`, `.update-control--error`.
- Repurpose `.update-corner`: keep `position: fixed`, top-right, but align to the
  titlebar height (≈ vertically centered in the ~28px `hiddenInset` strip rather
  than 18px down) and keep `pointer-events` scoping.
- Add `.version-badge`: slim inline-flex, small muted text (~0.7rem, weight
  ~600), tight horizontal padding, no glass background (transparent / very
  subtle), `-webkit-app-region: no-drag` so it stays clickable inside the
  titlebar drag region, subtle hover/active state, and a `.version-badge--ready`
  accent (green) when an update is installable. A `.version-badge__spinner`
  keyframe rotates the checking glyph.

### 4. Assistant update tools

`liveSession.ts`:

- Add `export const updaterToolNames = { checkForUpdates: "check_for_updates",
  installUpdate: "install_update", downloadUpdate: "download_update" }`.
- Add three `functionDeclarations` (no parameters):
  - `check_for_updates` — "Check whether a newer version of FamilyHub is
    available. Reports the current version and result."
  - `download_update` — "Download an available update now (normally downloads
    automatically in the background)."
  - `install_update` — "Install a downloaded update and relaunch the app. Only
    works once an update has finished downloading. Confirm with the user first."
- Add one system-instruction sentence: James can check for, download, and
  install app updates with these tools, and must confirm out loud before
  installing (which relaunches the app).

`updater.ts`:

- Extend `UpdaterAdapter` with `downloadUpdate: () => Promise<unknown>`.
- Add `downloadNow(): Promise<UpdaterStatus>` to `UpdaterController` /
  `createUpdaterController`: when packaged and an update is `available`, call
  `updater.downloadUpdate()` (swallow + publish error via existing
  `publishCheckError`), then return current status; otherwise return status
  unchanged.

`ipc.ts` (`registerAssistantIpc`):

- Change signature to `registerAssistantIpc(dashboard?, updater?)` and thread the
  controller into `runTool`.
- `runTool` cases (mark user-initiated where relevant):
  - `check_for_updates` → `await updater?.checkNow()` → `{ ok: true, state,
    version, percent }`.
  - `download_update` → `await updater?.downloadNow()` → same shape.
  - `install_update` → `await updater?.installNow()` → same shape. (Installing
    relaunches the app via `quitAndInstall`; if state isn't `downloaded` it is a
    no-op and returns the current state so James can say "nothing to install".)
  - When `updater` is undefined (shouldn't happen in packaged app) return
    `{ ok: false, error: "Updater unavailable." }`.

`index.ts`:

- Reorder: build `const updater = registerUpdaterIpc({ appIsPackaged:
  app.isPackaged })` **before** `registerAssistantIpc(dashboard, updater)`, then
  `void updater.start()`.

## Data Flow

```
Badge mount ─ getVersion() ───────────────► current version (resting display)
            └ getStatus()/onStatus ───────► live UpdateState → icon + action

Badge click (idle)      → updater.check()   → status broadcast → re-render
Badge click (downloaded)→ updater.install() → quitAndInstall → relaunch

Voice: "any updates?"   → check_for_updates → controller.checkNow()  → spoken result
Voice: "download it"    → download_update   → controller.downloadNow()→ spoken result
Voice: "update & restart"→ install_update   → controller.installNow()→ relaunch
```

## Error Handling

- Background/silent check failures stay silent (existing `publishCheckError`
  logic: only user-initiated, non-missing-feed errors go to the `error` state).
- A manual badge click is user-initiated → real failures show `v1.2.3 !`
  (retry).
- Voice tool failures return `{ ok: false, error }`; James reports it briefly.
- Dev/unpackaged build: updater stays `idle`; tools are safe no-ops returning
  `idle` state.

## Testing

- `UpdateControl.test.tsx`: rewrite for the badge — for each state assert the
  rendered version text + glyph (and `%` for downloading), and that clicking
  fires `onCheck` (idle/error) or `onInstall` (downloaded), and is inert for
  checking/available/downloading.
- `updater.test.ts`: add a `downloadNow()` test — when `available`, it calls the
  adapter's `downloadUpdate`; when not packaged / not available, it is a no-op.

## Files Touched

- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/updater.ts`
- `apps/electron/src/main/updater.test.ts`
- `apps/electron/src/main/assistant/liveSession.ts`
- `apps/electron/src/main/assistant/ipc.ts`
- `apps/electron/src/preload/index.ts`
- `apps/electron/src/renderer/src/vite-env.d.ts`
- `apps/electron/src/renderer/src/UpdateControl.tsx`
- `apps/electron/src/renderer/src/UpdateControl.test.tsx`
- `apps/electron/src/renderer/src/styles.css`
