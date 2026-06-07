# Mac Release Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public GitHub Releases based macOS Apple Silicon release pipeline and in-app auto-update flow for FamilyHub.

**Architecture:** `electron-updater` runs only in the Electron main process and owns update checks, download state, and install. The renderer sees updater state through a small preload API and displays one compact control in the existing header. GitHub Actions builds signed/notarized ARM64 macOS artifacts and publishes the update metadata required by `electron-updater`.

**Tech Stack:** Electron 42, electron-builder 26, electron-updater, electron-vite, React 19, Vitest, GitHub Actions, macOS Developer ID signing/notarization.

---

## File Structure

- Modify `apps/electron/package.json`: add `electron-updater`, mac ARM64 release scripts, GitHub publish config, and mac `dmg` + `zip` targets.
- Modify `package-lock.json`: update dependency lockfile after installing `electron-updater`.
- Create `apps/electron/src/main/updater.ts`: focused main-process updater state machine and IPC registration.
- Create `apps/electron/src/main/updater.test.ts`: unit tests for updater state transitions and dev-mode behavior.
- Modify `apps/electron/src/main/index.ts`: register updater IPC after app readiness.
- Modify `apps/electron/src/preload/index.ts`: expose `window.familyHub.updater`.
- Modify `apps/electron/src/renderer/src/vite-env.d.ts`: add updater bridge and status types.
- Create `apps/electron/src/renderer/src/UpdateControl.tsx`: compact renderer update control.
- Create `apps/electron/src/renderer/src/UpdateControl.test.tsx`: component tests for hidden/downloaded/error states.
- Modify `apps/electron/src/renderer/src/App.tsx`: render the update control in the existing voice-strip side area.
- Modify `apps/electron/src/renderer/src/styles.css`: add compact update-control styles.
- Create `.github/workflows/release-mac.yml`: tag-triggered Apple Silicon release workflow.
- Modify `README.md`: document release tags and required GitHub secrets.

## Task 1: Add Release Dependencies and electron-builder Config

**Files:**
- Modify: `apps/electron/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the updater dependency**

Run:

```bash
npm install --workspace @family-hub/electron electron-updater@latest
```

Expected: `apps/electron/package.json` gains `electron-updater` in `dependencies`, and `package-lock.json` changes.

- [ ] **Step 2: Update Electron package scripts and build config**

Edit `apps/electron/package.json` so the relevant fields match this shape:

```json
{
  "scripts": {
    "build": "npm run typecheck && electron-vite build",
    "dev": "electron-vite dev",
    "dev:packed": "npm run package && open release/mac-arm64/FamilyHub.app",
    "dist": "npm run build && electron-builder",
    "dist:mac:arm64": "npm run build && electron-builder --mac --arm64",
    "release:mac:arm64": "npm run build && electron-builder --mac --arm64 --publish always",
    "lint": "eslint . --max-warnings=0",
    "package": "npm run build && electron-builder --dir",
    "preview": "electron-vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
  },
  "build": {
    "appId": "com.familyhub.app",
    "productName": "FamilyHub",
    "artifactName": "${productName}-${version}-${arch}.${ext}",
    "directories": {
      "output": "release"
    },
    "files": [
      "out/**/*",
      "package.json"
    ],
    "extraResources": [
      {
        "from": "../../sidecar",
        "to": "sidecar",
        "filter": ["**/*", "!.venv/**"]
      }
    ],
    "mac": {
      "category": "public.app-category.lifestyle",
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "extendInfo": {
        "NSAppleEventsUsageDescription": "FamilyHub uses Automation to read your Calendar and Reminders for the kitchen dashboard.",
        "NSMicrophoneUsageDescription": "FamilyHub uses the microphone to listen for the James wake word and assistant commands."
      },
      "hardenedRuntime": true,
      "notarize": true,
      "target": [
        {
          "target": "dmg",
          "arch": ["arm64"]
        },
        {
          "target": "zip",
          "arch": ["arm64"]
        }
      ]
    },
    "publish": [
      {
        "provider": "github",
        "releaseType": "release"
      }
    ],
    "win": {
      "target": "nsis"
    },
    "linux": {
      "target": "AppImage"
    }
  }
}
```

Preserve all existing dependency versions not related to `electron-updater`.

- [ ] **Step 3: Verify package metadata**

Run:

```bash
npm --workspace @family-hub/electron pkg get build.mac.target build.publish scripts.release:mac:arm64
```

Expected: output includes `dmg`, `zip`, `provider: github`, `releaseType: release`, and the `electron-builder --mac --arm64 --publish always` script.

- [ ] **Step 4: Commit**

```bash
git add apps/electron/package.json package-lock.json
git commit -m "build: configure mac arm64 release publishing"
```

## Task 2: Add Main-Process Updater Core

**Files:**
- Create: `apps/electron/src/main/updater.ts`
- Create: `apps/electron/src/main/updater.test.ts`

- [ ] **Step 1: Write the failing updater tests**

Create `apps/electron/src/main/updater.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpdaterController,
  type UpdaterAdapter,
  type UpdaterBroadcaster,
} from "./updater";

class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  autoDownload = false;
  checkForUpdates = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

function createBroadcaster(): UpdaterBroadcaster & {
  sent: unknown[];
} {
  return {
    sent: [],
    broadcast(_channel, payload) {
      this.sent.push(payload);
    },
  };
}

describe("createUpdaterController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("stays idle and never checks in development mode", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: false,
      updater,
    });

    await controller.start();
    await controller.checkNow();

    expect(controller.getStatus()).toMatchObject({ state: "idle" });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(broadcaster.sent).toEqual([]);
  });

  it("broadcasts checking and not-available states", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.checkNow();
    updater.emit("update-not-available", { version: "0.0.0" });

    expect(updater.autoDownload).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(broadcaster.sent).toMatchObject([
      { state: "checking" },
      { state: "not-available" },
    ]);
  });

  it("maps available, progress, downloaded, and install events", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    updater.emit("update-available", { version: "0.1.1" });
    updater.emit("download-progress", { percent: 42.4 });
    updater.emit("update-downloaded", { version: "0.1.1" });
    await controller.installNow();

    expect(controller.getStatus()).toMatchObject({
      state: "downloaded",
      version: "0.1.1",
    });
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(broadcaster.sent).toMatchObject([
      { state: "available", version: "0.1.1" },
      { state: "downloading", percent: 42 },
      { state: "downloaded", version: "0.1.1" },
    ]);
  });

  it("stores updater errors without throwing", () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    updater.emit("error", new Error("network failed"));

    expect(controller.getStatus()).toMatchObject({
      error: "network failed",
      state: "error",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --workspace @family-hub/electron test -- src/main/updater.test.ts
```

Expected: FAIL because `./updater` does not exist.

- [ ] **Step 3: Implement the updater controller and IPC registration**

Create `apps/electron/src/main/updater.ts`:

```typescript
import { BrowserWindow, ipcMain, type IpcMain } from "electron";
import { autoUpdater } from "electron-updater";

const updaterStatusChannel = "updater:status";
const updateCheckIntervalMs = 6 * 60 * 60 * 1000;

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdaterStatus {
  error?: string;
  percent?: number;
  state: UpdateState;
  version?: string;
}

export interface UpdaterAdapter {
  autoDownload: boolean;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface UpdaterBroadcaster {
  broadcast: (channel: string, payload: unknown) => void;
}

export interface UpdaterController {
  checkNow: () => Promise<UpdaterStatus>;
  getStatus: () => UpdaterStatus;
  installNow: () => Promise<UpdaterStatus>;
  start: () => Promise<void>;
}

export function createUpdaterController({
  broadcaster,
  isPackaged,
  updater,
}: {
  broadcaster: UpdaterBroadcaster;
  isPackaged: boolean;
  updater: UpdaterAdapter;
}): UpdaterController {
  let status: UpdaterStatus = { state: "idle" };
  let intervalId: NodeJS.Timeout | null = null;

  function publish(next: UpdaterStatus): UpdaterStatus {
    status = next;
    broadcaster.broadcast(updaterStatusChannel, status);
    return status;
  }

  function readVersion(info: unknown): string | undefined {
    return isRecord(info) && typeof info.version === "string"
      ? info.version
      : undefined;
  }

  updater.autoDownload = true;
  updater.on("checking-for-update", () => {
    publish({ state: "checking" });
  });
  updater.on("update-available", (info) => {
    publish({ state: "available", version: readVersion(info) });
  });
  updater.on("update-not-available", (info) => {
    publish({ state: "not-available", version: readVersion(info) });
  });
  updater.on("download-progress", (progress) => {
    const percent =
      isRecord(progress) && typeof progress.percent === "number"
        ? Math.round(progress.percent)
        : undefined;
    publish({ state: "downloading", percent });
  });
  updater.on("update-downloaded", (info) => {
    publish({ state: "downloaded", version: readVersion(info) });
  });
  updater.on("error", (error) => {
    publish({ state: "error", error: readError(error) });
  });

  async function checkNow(): Promise<UpdaterStatus> {
    if (!isPackaged) {
      return status;
    }

    publish({ state: "checking" });

    try {
      await updater.checkForUpdates();
    } catch (error) {
      publish({ state: "error", error: readError(error) });
    }

    return status;
  }

  return {
    async checkNow() {
      return checkNow();
    },
    getStatus() {
      return status;
    },
    async installNow() {
      if (status.state === "downloaded") {
        updater.quitAndInstall(false, true);
      }

      return status;
    },
    async start() {
      if (!isPackaged) {
        return;
      }

      await checkNow();
      intervalId = setInterval(() => {
        void checkNow();
      }, updateCheckIntervalMs);
      intervalId.unref?.();
    },
  };
}

export function registerUpdaterIpc({
  appIsPackaged,
  ipc = ipcMain,
}: {
  appIsPackaged: boolean;
  ipc?: Pick<IpcMain, "handle">;
}): UpdaterController {
  const controller = createUpdaterController({
    broadcaster: {
      broadcast(channel, payload) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(channel, payload);
          }
        }
      },
    },
    isPackaged: appIsPackaged,
    updater: autoUpdater,
  });

  ipc.handle("updater:getStatus", () => controller.getStatus());
  ipc.handle("updater:check", () => controller.checkNow());
  ipc.handle("updater:install", () => controller.installNow());

  return controller;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Update failed.";
}
```

- [ ] **Step 4: Run updater tests to verify they pass**

Run:

```bash
npm --workspace @family-hub/electron test -- src/main/updater.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/updater.ts apps/electron/src/main/updater.test.ts
git commit -m "feat: add main process updater controller"
```

## Task 3: Wire Updater IPC Into Main, Preload, and Types

**Files:**
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/src/vite-env.d.ts`

- [ ] **Step 1: Add renderer bridge types**

Edit `apps/electron/src/renderer/src/vite-env.d.ts` first and add these types near the existing bridge types:

```typescript
type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

interface UpdaterStatus {
  error?: string;
  percent?: number;
  state: UpdateState;
  version?: string;
}

interface UpdaterBridge {
  check: () => Promise<UpdaterStatus>;
  getStatus: () => Promise<UpdaterStatus>;
  install: () => Promise<UpdaterStatus>;
  onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
}
```

Then add `updater: UpdaterBridge;` to `FamilyHubBridge`.

- [ ] **Step 2: Run typecheck after type-only changes**

Run:

```bash
npm --workspace @family-hub/electron run typecheck
```

Expected: PASS. This step verifies the new global updater types are valid before wiring IPC and renderer code.

- [ ] **Step 3: Register updater IPC in main**

Modify `apps/electron/src/main/index.ts`:

```typescript
import { registerUpdaterIpc } from "./updater";
```

Inside `app.whenReady().then(async () => { ... })`, after `registerAssistantIpc(...)`, add:

```typescript
  const updater = registerUpdaterIpc({ appIsPackaged: app.isPackaged });
  void updater.start();
```

Keep the existing app startup order intact.

- [ ] **Step 4: Expose updater IPC in preload**

Modify `apps/electron/src/preload/index.ts` and add this sibling object beside `assistant` and `dashboard`:

```typescript
  updater: {
    check: () =>
      ipcRenderer.invoke("updater:check") as Promise<unknown>,
    getStatus: () =>
      ipcRenderer.invoke("updater:getStatus") as Promise<unknown>,
    install: () =>
      ipcRenderer.invoke("updater:install") as Promise<unknown>,
    onStatus: makeSubscription("updater:status"),
  },
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm --workspace @family-hub/electron run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/index.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/src/vite-env.d.ts
git commit -m "feat: expose updater bridge"
```

## Task 4: Add Renderer Update Control

**Files:**
- Create: `apps/electron/src/renderer/src/UpdateControl.tsx`
- Create: `apps/electron/src/renderer/src/UpdateControl.test.tsx`
- Modify: `apps/electron/src/renderer/src/App.tsx`
- Modify: `apps/electron/src/renderer/src/styles.css`

- [ ] **Step 1: Write failing renderer component tests**

Create `apps/electron/src/renderer/src/UpdateControl.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdateControlView } from "./UpdateControl";

describe("UpdateControlView", () => {
  it("renders nothing when idle or up to date", () => {
    expect(
      renderToStaticMarkup(
        <UpdateControlView
          status={{ state: "idle" }}
          onCheck={() => undefined}
          onInstall={() => undefined}
        />,
      ),
    ).toBe("");

    expect(
      renderToStaticMarkup(
        <UpdateControlView
          status={{ state: "not-available" }}
          onCheck={() => undefined}
          onInstall={() => undefined}
        />,
      ),
    ).toBe("");
  });

  it("shows progress while downloading", () => {
    expect(
      renderToStaticMarkup(
        <UpdateControlView
          status={{ state: "downloading", percent: 42 }}
          onCheck={() => undefined}
          onInstall={() => undefined}
        />,
      ),
    ).toContain("Downloading 42%");
  });

  it("shows a restart button after download", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "downloaded", version: "0.1.1" }}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("0.1.1 ready");
    expect(html).toContain("Restart");
  });

  it("shows a retry button for errors", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "error", error: "network failed" }}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("network failed");
    expect(html).toContain("Retry");
  });
});
```

- [ ] **Step 2: Run renderer test to verify it fails**

Run:

```bash
npm --workspace @family-hub/electron test -- src/renderer/src/UpdateControl.test.tsx
```

Expected: FAIL because `./UpdateControl` does not exist.

- [ ] **Step 3: Implement UpdateControl**

Create `apps/electron/src/renderer/src/UpdateControl.tsx`:

```tsx
import { useEffect, useState } from "react";

export function UpdateControl(): React.JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ state: "idle" });

  useEffect(() => {
    let mounted = true;

    window.familyHub.updater
      .getStatus()
      .then((nextStatus) => {
        if (mounted) {
          setStatus(nextStatus);
        }
      })
      .catch(() => {
        if (mounted) {
          setStatus({ state: "error", error: "Unable to read update status." });
        }
      });

    const unsubscribe = window.familyHub.updater.onStatus(setStatus);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <UpdateControlView
      status={status}
      onCheck={() => {
        void window.familyHub.updater.check().then(setStatus);
      }}
      onInstall={() => {
        void window.familyHub.updater.install();
      }}
    />
  );
}

export function UpdateControlView({
  status,
  onCheck,
  onInstall,
}: {
  onCheck: () => void;
  onInstall: () => void;
  status: UpdaterStatus;
}): React.JSX.Element | null {
  switch (status.state) {
    case "available":
      return (
        <div className="update-control" role="status">
          <span>{status.version ? `${status.version} available` : "Update available"}</span>
          <span>Downloading...</span>
        </div>
      );
    case "checking":
      return (
        <div className="update-control" role="status">
          <span>Checking updates...</span>
        </div>
      );
    case "downloading":
      return (
        <div className="update-control" role="status">
          <span>Downloading {status.percent ?? 0}%</span>
        </div>
      );
    case "downloaded":
      return (
        <div className="update-control update-control--ready" role="status">
          <span>{status.version ? `${status.version} ready` : "Update ready"}</span>
          <button className="secondary-button" onClick={onInstall} type="button">
            Restart
          </button>
        </div>
      );
    case "error":
      return (
        <div className="update-control update-control--error" role="status">
          <span>{status.error ?? "Update failed."}</span>
          <button className="secondary-button" onClick={onCheck} type="button">
            Retry
          </button>
        </div>
      );
    case "idle":
    case "not-available":
      return null;
  }
}
```

- [ ] **Step 4: Render the control in App**

Modify `apps/electron/src/renderer/src/App.tsx`:

```tsx
import { UpdateControl } from "./UpdateControl";
```

Inside `<div className="voice-strip-side">`, before `<MicrophoneMeter ... />`, add:

```tsx
          <UpdateControl />
```

- [ ] **Step 5: Add styles**

Append to `apps/electron/src/renderer/src/styles.css` near the voice-strip styles:

```css
.update-control {
  align-items: center;
  background: #f3f6f5;
  border: 1px solid #cdd8d9;
  border-radius: 8px;
  color: #263538;
  display: flex;
  gap: 8px;
  justify-content: space-between;
  min-height: 40px;
  padding: 6px 8px 6px 12px;
}

.update-control span {
  font-size: 0.78rem;
  font-weight: 800;
  overflow-wrap: anywhere;
}

.update-control button {
  min-height: 30px;
  padding: 0 10px;
}

.update-control--ready {
  background: #eef7f4;
  border-color: #82b8a7;
}

.update-control--error {
  background: #fff1f0;
  border-color: #e29a92;
  color: #8f2219;
}
```

- [ ] **Step 6: Run renderer tests and typecheck**

Run:

```bash
npm --workspace @family-hub/electron test -- src/renderer/src/UpdateControl.test.tsx
npm --workspace @family-hub/electron run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 7: Commit**

```bash
git add apps/electron/src/renderer/src/UpdateControl.tsx apps/electron/src/renderer/src/UpdateControl.test.tsx apps/electron/src/renderer/src/App.tsx apps/electron/src/renderer/src/styles.css
git commit -m "feat: show update status in renderer"
```

## Task 5: Add GitHub Actions macOS Release Workflow

**Files:**
- Create: `.github/workflows/release-mac.yml`

- [ ] **Step 1: Create release workflow**

Create `.github/workflows/release-mac.yml`:

```yaml
name: Release macOS Apple Silicon

on:
  push:
    tags:
      - "v*.*.*"

permissions:
  contents: write

jobs:
  release-mac:
    name: Build and publish macOS ARM64
    runs-on: macos-latest
    env:
      APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
      APPLE_ID: ${{ secrets.APPLE_ID }}
      APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      CSC_LINK: ${{ secrets.MAC_CERTIFICATE }}
      CSC_KEY_PASSWORD: ${{ secrets.MAC_CERTIFICATE_PASSWORD }}
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - name: Check signing secrets
        run: |
          test -n "$CSC_LINK"
          test -n "$CSC_KEY_PASSWORD"
          test -n "$APPLE_ID"
          test -n "$APPLE_APP_SPECIFIC_PASSWORD"
          test -n "$APPLE_TEAM_ID"

      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 25
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm --workspace @family-hub/electron test

      - name: Publish release
        run: npm --workspace @family-hub/electron run release:mac:arm64

      - name: Verify release artifacts
        run: |
          test -n "$(find apps/electron/release -maxdepth 1 -name '*.dmg' -print -quit)"
          test -n "$(find apps/electron/release -maxdepth 1 -name '*.zip' -print -quit)"
          test -n "$(find apps/electron/release -maxdepth 1 -name '*.blockmap' -print -quit)"
          test -f apps/electron/release/latest-mac.yml
```

- [ ] **Step 2: Validate workflow syntax locally**

Run:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release-mac.yml"); puts "workflow yaml ok"'
```

Expected: prints `workflow yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-mac.yml
git commit -m "ci: publish mac apple silicon releases"
```

## Task 6: Document Release Setup

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add release documentation**

Append this section to `README.md`:

```markdown
## macOS Apple Silicon releases

FamilyHub releases are published from version tags to public GitHub Releases.
The release workflow builds only Apple Silicon macOS artifacts.

Required GitHub Actions secrets:

- `MAC_CERTIFICATE` — base64 encoded Developer ID Application `.p12` export.
- `MAC_CERTIFICATE_PASSWORD` — password for that `.p12` export.
- `APPLE_ID` — Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password for notarization.
- `APPLE_TEAM_ID` — Apple Developer team ID.

Release steps:

```bash
npm version patch --workspace @family-hub/electron
git push
git push origin v0.0.1
```

Use the actual version tag created by `npm version`. GitHub Actions publishes
the DMG, ZIP, blockmaps, and `latest-mac.yml`. The kitchen Mac must install a
signed release build once; after that, it checks the public GitHub release feed
and prompts to restart when a newer version is downloaded.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document mac release setup"
```

## Task 7: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm --workspace @family-hub/electron test -- src/main/updater.test.ts src/renderer/src/UpdateControl.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run full Electron workspace tests**

Run:

```bash
npm --workspace @family-hub/electron test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck and lint**

Run:

```bash
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Build the app**

Run:

```bash
npm --workspace @family-hub/electron run build
```

Expected: PASS and `apps/electron/out/` is regenerated.

- [ ] **Step 5: Dry-run mac ARM64 packaging without publishing**

Run on Apple Silicon macOS:

```bash
npm --workspace @family-hub/electron run dist:mac:arm64 -- --publish never
```

Expected: PASS and `apps/electron/release/` contains a DMG, ZIP, blockmap files, and `latest-mac.yml`.

- [ ] **Step 6: Inspect changed files**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: only intended release/update files are changed or committed. Existing unrelated working-tree changes from before this work remain untouched.

- [ ] **Step 7: Manual release smoke test**

After pushing the implementation branch and merging it:

```bash
npm version patch --workspace @family-hub/electron
git push
git push origin "$(node -p '"v" + require("./apps/electron/package.json").version')"
```

Expected: GitHub Actions publishes a public release. Install that DMG on the kitchen Mac. For the next patch tag, confirm FamilyHub downloads the update and the `Restart` button relaunches into the newer version.
