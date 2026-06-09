# Slim Version Badge + Assistant Update Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the glass "check for updates" pill with a slim titlebar version badge, expose the current app version to the renderer, and give the voice assistant tools to check / download / install updates.

**Architecture:** The Electron main process already runs an `UpdaterController` (check + auto-download + auto-install). We (1) add a `downloadNow()` method + `app:getVersion` IPC, (2) rewrite the renderer `UpdateControl` into a single morphing `version-badge` button, (3) register three Gemini function tools that call the controller. The controller is created before the assistant IPC so it can be threaded into the tool dispatcher.

**Tech Stack:** Electron, electron-updater, React 19 (renderer, server-rendered tests via `react-dom/server`), Vitest, `@google/genai` Live API.

**Spec:** `docs/superpowers/specs/2026-06-09-version-badge-update-tools-design.md`

**How to run tests:** from `apps/electron/`, run `npx vitest run <path>` for one file or `npm test` for all. Typecheck with `npm run typecheck`, lint with `npm run lint`.

---

## File Structure

- `apps/electron/src/main/updater.ts` — add `downloadUpdate` to `UpdaterAdapter`, `downloadNow()` to controller.
- `apps/electron/src/main/updater.test.ts` — `FakeUpdater.downloadUpdate` stub + `downloadNow` tests.
- `apps/electron/src/main/index.ts` — `app:getVersion` handler; create updater before assistant; pass controller in.
- `apps/electron/src/preload/index.ts` — `getVersion` on the `familyHub` bridge.
- `apps/electron/src/renderer/src/vite-env.d.ts` — `getVersion` on `FamilyHubBridge`.
- `apps/electron/src/renderer/src/UpdateControl.tsx` — rewrite into the version badge + pure helpers.
- `apps/electron/src/renderer/src/UpdateControl.test.tsx` — rewrite for the badge.
- `apps/electron/src/renderer/src/styles.css` — drop `.update-control*`, add `.version-badge*`.
- `apps/electron/src/main/assistant/liveSession.ts` — `updaterToolNames`, 3 declarations, system-instruction line.
- `apps/electron/src/main/assistant/ipc.ts` — accept the controller, 3 `runTool` cases.

---

## Task 1: Updater `downloadNow()` + adapter `downloadUpdate`

**Files:**
- Modify: `apps/electron/src/main/updater.ts`
- Test: `apps/electron/src/main/updater.test.ts`

- [ ] **Step 1: Add `downloadUpdate` to the `FakeUpdater` test double**

In `apps/electron/src/main/updater.test.ts`, add a stub method to the class (around line 10-16) so it still satisfies `UpdaterAdapter` once the interface grows:

```typescript
class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  autoDownload = false;
  checkForUpdates = vi.fn(async () => {
    this.emit("checking-for-update");
  });
  downloadUpdate = vi.fn(async () => {
    this.emit("download-progress", { percent: 0 });
  });
  quitAndInstall = vi.fn();
}
```

- [ ] **Step 2: Write the failing `downloadNow` tests**

Add these two tests inside the `describe("createUpdaterController", ...)` block in `apps/electron/src/main/updater.test.ts` (e.g. after the "does not install before an update is downloaded" test):

```typescript
it("downloads an available update on demand", async () => {
  const updater = new FakeUpdater();
  const broadcaster = createBroadcaster();
  const controller = createUpdaterController({
    broadcaster,
    isPackaged: true,
    updater,
  });

  updater.emit("update-available", { version: "0.1.1" });
  await controller.downloadNow();

  expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
});

it("does not download when no update is available", async () => {
  const updater = new FakeUpdater();
  const broadcaster = createBroadcaster();
  const controller = createUpdaterController({
    broadcaster,
    isPackaged: true,
    updater,
  });

  await controller.downloadNow();

  expect(updater.downloadUpdate).not.toHaveBeenCalled();
});

it("never downloads in development mode", async () => {
  const updater = new FakeUpdater();
  const broadcaster = createBroadcaster();
  const controller = createUpdaterController({
    broadcaster,
    isPackaged: false,
    updater,
  });

  updater.emit("update-available", { version: "0.1.1" });
  await controller.downloadNow();

  expect(updater.downloadUpdate).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/electron && npx vitest run src/main/updater.test.ts`
Expected: FAIL — `controller.downloadNow is not a function` (and a type error that `downloadUpdate` is not on `UpdaterAdapter`).

- [ ] **Step 4: Add `downloadUpdate` to the `UpdaterAdapter` interface**

In `apps/electron/src/main/updater.ts`, extend the interface (around line 32-37):

```typescript
export interface UpdaterAdapter {
  autoDownload: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}
```

- [ ] **Step 5: Add `downloadNow` to the `UpdaterController` interface**

In `apps/electron/src/main/updater.ts`, extend the controller interface (around line 43-48):

```typescript
export interface UpdaterController {
  checkNow: () => Promise<UpdaterStatus>;
  downloadNow: () => Promise<UpdaterStatus>;
  getStatus: () => UpdaterStatus;
  installNow: () => Promise<UpdaterStatus>;
  start: () => Promise<void>;
}
```

- [ ] **Step 6: Implement `downloadNow` in the returned controller**

In `apps/electron/src/main/updater.ts`, add a `downloadNow` method to the object returned by `createUpdaterController` (the `return { ... }` block around line 194). Place it next to `checkNow`:

```typescript
    async downloadNow() {
      // electron-updater auto-downloads in the background, so this is only a
      // manual nudge: download is meaningful exactly when an update is known to
      // be available. quietly no-op otherwise (idle/not-available/downloaded).
      if (!isPackaged || status.state !== "available") {
        return status;
      }

      try {
        await updater.downloadUpdate();
      } catch (error) {
        publishCheckError(error);
      }

      return status;
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/electron && npx vitest run src/main/updater.test.ts`
Expected: PASS (all existing tests plus the three new ones).

- [ ] **Step 8: Typecheck**

Run: `cd apps/electron && npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/electron/src/main/updater.ts apps/electron/src/main/updater.test.ts
git commit -m "feat(updater): add downloadNow() for on-demand update download"
```

---

## Task 2: Expose the current app version to the renderer

**Files:**
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/src/vite-env.d.ts`

- [ ] **Step 1: Add the `app:getVersion` IPC handler**

In `apps/electron/src/main/index.ts`, inside `app.whenReady().then(...)`, add the handler next to the existing `app:ping` handler (line 63):

```typescript
  ipcMain.handle("app:ping", () => "pong");
  ipcMain.handle("app:getVersion", () => app.getVersion());
```

- [ ] **Step 2: Expose `getVersion` from preload**

In `apps/electron/src/preload/index.ts`, add `getVersion` to the `familyHub` object next to `ping` (line 100):

```typescript
  ping: () => ipcRenderer.invoke("app:ping") as Promise<string>,
  getVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<string>,
```

- [ ] **Step 3: Add `getVersion` to the renderer bridge type**

In `apps/electron/src/renderer/src/vite-env.d.ts`, extend `FamilyHubBridge` (around line 210-215):

```typescript
interface FamilyHubBridge {
  assistant: AssistantBridge;
  dashboard: DashboardBridge;
  updater: UpdaterBridge;
  ping: () => Promise<string>;
  getVersion: () => Promise<string>;
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/electron && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/index.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/src/vite-env.d.ts
git commit -m "feat: expose current app version to the renderer over IPC"
```

---

## Task 3: Rewrite `UpdateControl` into the version badge

**Files:**
- Modify: `apps/electron/src/renderer/src/UpdateControl.tsx`
- Test: `apps/electron/src/renderer/src/UpdateControl.test.tsx`

Tests run under Node via `react-dom/server` (no DOM/jsdom), so click handlers can't be fired. We test two pure helpers (`badgeAction`, `badgeContent`) directly and assert the server-rendered markup of `UpdateControlView`.

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `apps/electron/src/renderer/src/UpdateControl.test.tsx` with:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  UpdateControlView,
  badgeAction,
  badgeContent,
} from "./UpdateControl";

describe("badgeAction", () => {
  it("checks when idle, not-available, or errored", () => {
    expect(badgeAction("idle")).toBe("check");
    expect(badgeAction("not-available")).toBe("check");
    expect(badgeAction("error")).toBe("check");
  });

  it("installs when downloaded", () => {
    expect(badgeAction("downloaded")).toBe("install");
  });

  it("is inert while checking, available, or downloading", () => {
    expect(badgeAction("checking")).toBeNull();
    expect(badgeAction("available")).toBeNull();
    expect(badgeAction("downloading")).toBeNull();
  });
});

describe("badgeContent", () => {
  it("shows the running version and a checkmark when up to date", () => {
    expect(badgeContent({ state: "idle" }, "1.2.3")).toMatchObject({
      version: "v1.2.3",
      glyph: "✓",
    });
    expect(badgeContent({ state: "not-available" }, "1.2.3")).toMatchObject({
      version: "v1.2.3",
      glyph: "✓",
    });
  });

  it("shows the target version and percent while downloading", () => {
    expect(
      badgeContent({ state: "downloading", version: "1.4.0", percent: 42 }, "1.2.3"),
    ).toMatchObject({ version: "v1.4.0", glyph: "↓", percent: 42 });
  });

  it("shows the new version and a restart glyph when downloaded", () => {
    expect(
      badgeContent({ state: "downloaded", version: "1.4.0" }, "1.2.3"),
    ).toMatchObject({ version: "v1.4.0", glyph: "↻" });
  });

  it("shows an error glyph on failure", () => {
    expect(badgeContent({ state: "error", error: "boom" }, "1.2.3")).toMatchObject({
      glyph: "!",
    });
  });
});

describe("UpdateControlView", () => {
  it("renders version + checkmark when up to date", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "not-available" }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("v1.2.3");
    expect(html).toContain("✓");
  });

  it("renders the download percent while downloading", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "downloading", percent: 42 }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("↓");
    expect(html).toContain("42%");
  });

  it("renders the restart glyph and ready accent when downloaded", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "downloaded", version: "1.4.0" }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("v1.4.0");
    expect(html).toContain("↻");
    expect(html).toContain("version-badge--ready");
  });

  it("disables the badge while checking and shows a spinner", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "checking" }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("version-badge__glyph--spin");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/electron && npx vitest run src/renderer/src/UpdateControl.test.tsx`
Expected: FAIL — `badgeAction`/`badgeContent` are not exported and `UpdateControlView` doesn't accept `appVersion`.

- [ ] **Step 3: Rewrite `UpdateControl.tsx`**

Replace the entire contents of `apps/electron/src/renderer/src/UpdateControl.tsx` with:

```tsx
import { useEffect, useState } from "react";

// Which action a click on the badge performs. Passive states have none.
export function badgeAction(state: UpdateState): "check" | "install" | null {
  switch (state) {
    case "idle":
    case "not-available":
    case "error":
      return "check";
    case "downloaded":
      return "install";
    case "checking":
    case "available":
    case "downloading":
      return null;
  }
}

// The version text, trailing glyph, label, and optional percent the badge shows.
// At rest the badge shows the running app version; once an update is known it
// shows that update's target version.
export function badgeContent(
  status: UpdaterStatus,
  appVersion: string,
): { version: string; glyph: string; label: string; percent?: number } {
  const tag = (raw: string): string => (raw ? `v${raw}` : "");
  const target = tag(status.version ?? appVersion);

  switch (status.state) {
    case "checking":
      return { version: tag(appVersion), glyph: "⟳", label: "Checking for updates…" };
    case "available":
      return { version: target, glyph: "↓", label: "Update available" };
    case "downloading":
      return {
        version: target,
        glyph: "↓",
        label: "Downloading update",
        percent: status.percent ?? 0,
      };
    case "downloaded":
      return { version: target, glyph: "↻", label: "Update ready — restart" };
    case "error":
      return { version: tag(appVersion), glyph: "!", label: "Update failed — retry" };
    case "idle":
    case "not-available":
      return {
        version: tag(appVersion),
        glyph: "✓",
        label: "Up to date — check for updates",
      };
  }
}

export function UpdateControl(): React.JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ state: "idle" });
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    let mounted = true;

    window.familyHub
      .getVersion()
      .then((version) => {
        if (mounted) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        // Version is non-critical chrome; leave it blank if unavailable.
      });

    window.familyHub.updater
      .getStatus()
      .then((nextStatus) => {
        if (mounted) {
          setStatus(nextStatus);
        }
      })
      .catch(() => {
        // Backend not reachable (e.g. auto-updater disabled) — stay at idle so
        // the badge shows "up to date" rather than an error.
        if (mounted) {
          setStatus({ state: "idle" });
        }
      });

    const unsubscribe = window.familyHub.updater.onStatus((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <UpdateControlView
      status={status}
      appVersion={appVersion}
      onCheck={() => {
        void window.familyHub.updater
          .check()
          .then(setStatus)
          .catch(() => {
            setStatus({ state: "error", error: "Unable to check for updates." });
          });
      }}
      onInstall={() => {
        void window.familyHub.updater.install();
      }}
    />
  );
}

export function UpdateControlView({
  status,
  appVersion,
  onCheck,
  onInstall,
}: {
  appVersion: string;
  onCheck: () => void;
  onInstall: () => void;
  status: UpdaterStatus;
}): React.JSX.Element {
  const action = badgeAction(status.state);
  const { version, glyph, label, percent } = badgeContent(status, appVersion);
  const spinning = status.state === "checking";
  const ready = status.state === "downloaded";

  return (
    <button
      type="button"
      className={ready ? "version-badge version-badge--ready" : "version-badge"}
      aria-label={label}
      title={label}
      disabled={action === null}
      onClick={() => {
        if (action === "check") {
          onCheck();
        } else if (action === "install") {
          onInstall();
        }
      }}
    >
      {version ? <span className="version-badge__version">{version}</span> : null}
      <span
        aria-hidden="true"
        className={
          spinning
            ? "version-badge__glyph version-badge__glyph--spin"
            : "version-badge__glyph"
        }
      >
        {glyph}
      </span>
      {percent !== undefined ? (
        <span className="version-badge__percent">{percent}%</span>
      ) : null}
    </button>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/electron && npx vitest run src/renderer/src/UpdateControl.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd apps/electron && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/renderer/src/UpdateControl.tsx apps/electron/src/renderer/src/UpdateControl.test.tsx
git commit -m "feat(renderer): morphing version badge replaces the update pill"
```

---

## Task 4: Slim badge CSS

**Files:**
- Modify: `apps/electron/src/renderer/src/styles.css`

- [ ] **Step 1: Remove the old glass pill styles**

In `apps/electron/src/renderer/src/styles.css`, delete the five `.update-control` rules (lines ~163-197): `.update-control`, `.update-control span`, `.update-control button`, `.update-control--ready`, `.update-control--error`.

- [ ] **Step 2: Replace the `.update-corner` rules with badge styles**

Replace the `.update-corner` and `.update-corner > *` block (lines ~1975-1987) with:

```css
/* Updater badge: a slim, low-chrome version pill in the top-right titlebar
   strip, aligned to the macOS traffic lights. Always present (passive chrome);
   the trailing glyph encodes update state. */
.update-corner {
  position: fixed;
  inset-block-start: 6px;
  inset-inline-end: 12px;
  z-index: 30;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
}

.update-corner > * {
  pointer-events: auto;
}

.version-badge {
  -webkit-app-region: no-drag;
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--hub-text-2, #5b6b6d);
  cursor: pointer;
  display: inline-flex;
  font-size: 0.72rem;
  font-weight: 600;
  gap: 4px;
  height: 22px;
  letter-spacing: 0.01em;
  opacity: 0.72;
  padding: 0 6px;
  transition: opacity 120ms ease, background 120ms ease;
}

.version-badge:hover:not(:disabled) {
  background: var(--hub-glass-2, rgba(38, 53, 56, 0.06));
  opacity: 1;
}

.version-badge:disabled {
  cursor: default;
}

.version-badge__glyph {
  font-size: 0.82rem;
  line-height: 1;
}

.version-badge__percent {
  font-variant-numeric: tabular-nums;
}

.version-badge--ready {
  color: #1f9d4d;
  opacity: 1;
}

.version-badge--ready:hover:not(:disabled) {
  background: rgba(31, 157, 77, 0.12);
}

.version-badge__glyph--spin {
  animation: version-badge-spin 0.9s linear infinite;
  display: inline-block;
}

@keyframes version-badge-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 3: Verify no other references to the removed classes remain**

Run: `cd apps/electron && grep -rn "update-control" src`
Expected: no matches.

- [ ] **Step 4: Lint**

Run: `cd apps/electron && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/renderer/src/styles.css
git commit -m "style(renderer): slim titlebar version badge, drop glass update pill"
```

---

## Task 5: Assistant updater tool declarations

**Files:**
- Modify: `apps/electron/src/main/assistant/liveSession.ts`

- [ ] **Step 1: Add `updaterToolNames`**

In `apps/electron/src/main/assistant/liveSession.ts`, add a new exported constant after `weatherToolName` (line 63):

```typescript
export const updaterToolNames = {
  checkForUpdates: "check_for_updates",
  downloadUpdate: "download_update",
  installUpdate: "install_update",
} as const;
```

- [ ] **Step 2: Add the three function declarations**

In `apps/electron/src/main/assistant/liveSession.ts`, inside the `functionDeclarations` array, add these three entries immediately before the closing `]` of that array (just after the `dashboardToolNames.hideNotes` entry, around line 367):

```typescript
      {
        name: updaterToolNames.checkForUpdates,
        description:
          "Check whether a newer version of the FamilyHub app is available. Reports the current version and whether an update was found. Call this when the user asks about updates or the app version.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: updaterToolNames.downloadUpdate,
        description:
          "Download an available update now. Updates normally download automatically in the background, so only use this if the user explicitly asks to download an available update right away.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: updaterToolNames.installUpdate,
        description:
          "Install a downloaded update and relaunch the app. Only works once an update has finished downloading. This restarts the app, so confirm out loud with the user before calling it.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
```

- [ ] **Step 3: Add a system-instruction line**

In `apps/electron/src/main/assistant/liveSession.ts`, in the `buildSystemInstruction` return array, add this string just before the final "When the user signals they are finished…" line (around line 398):

```typescript
    "You can manage app updates: call check_for_updates to see whether a newer version is available, download_update to download an available update immediately, and install_update to install a downloaded update and relaunch the app. Always confirm out loud before calling install_update, since it restarts the app.",
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/electron && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the assistant session tests**

Run: `cd apps/electron && npx vitest run src/main/assistant/liveSession.test.ts`
Expected: PASS (declarations are additive; no behavioural test should break).

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/assistant/liveSession.ts
git commit -m "feat(assistant): declare check/download/install update tools"
```

---

## Task 6: Dispatch update tools through the controller

**Files:**
- Modify: `apps/electron/src/main/assistant/ipc.ts`
- Modify: `apps/electron/src/main/index.ts`

- [ ] **Step 1: Import the tool names and controller type in `ipc.ts`**

In `apps/electron/src/main/assistant/ipc.ts`, add `updaterToolNames` to the `liveSession` import (lines 4-10):

```typescript
import {
  GeminiLiveSession,
  buildSystemInstruction,
  calendarToolNames,
  dashboardToolNames,
  noteToolNames,
  updaterToolNames,
  weatherToolName,
} from "./liveSession";
```

Then add a type-only import for the controller near the other type imports (after line 26-ish, the `DashboardController` import):

```typescript
import type { UpdaterController } from "../updater";
```

- [ ] **Step 2: Accept the controller in `registerAssistantIpc`**

In `apps/electron/src/main/assistant/ipc.ts`, change the function signature (line 38):

```typescript
export function registerAssistantIpc(
  dashboard?: DashboardController,
  updater?: UpdaterController,
): void {
```

- [ ] **Step 3: Add the three `runTool` cases**

In `apps/electron/src/main/assistant/ipc.ts`, add these cases to the `switch (name)` in `runTool`, immediately before the `default:` case (around line 263):

```typescript
      case updaterToolNames.checkForUpdates: {
        if (!updater) {
          return { ok: false, error: "Updater unavailable." };
        }
        const result = await updater.checkNow();
        return { ok: true, ...result };
      }
      case updaterToolNames.downloadUpdate: {
        if (!updater) {
          return { ok: false, error: "Updater unavailable." };
        }
        const result = await updater.downloadNow();
        return { ok: true, ...result };
      }
      case updaterToolNames.installUpdate: {
        if (!updater) {
          return { ok: false, error: "Updater unavailable." };
        }
        const result = await updater.installNow();
        return { ok: true, ...result };
      }
```

- [ ] **Step 4: Create the updater before the assistant and pass it in (`index.ts`)**

In `apps/electron/src/main/index.ts`, reorder the setup inside `app.whenReady().then(...)` so the updater exists before the assistant IPC (replace lines 64-67):

```typescript
  const dashboard = registerDashboardIpc(app.getPath("userData"));
  const updater = registerUpdaterIpc({ appIsPackaged: app.isPackaged });
  registerAssistantIpc(dashboard, updater);
  void updater.start();
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/electron && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full assistant + updater test suites**

Run: `cd apps/electron && npx vitest run src/main`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/electron/src/main/assistant/ipc.ts apps/electron/src/main/index.ts
git commit -m "feat(assistant): route update tools to the updater controller"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `cd apps/electron && npm test`
Expected: all tests PASS.

- [ ] **Step 2: Typecheck and lint**

Run: `cd apps/electron && npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Build the renderer/main bundles**

Run: `cd apps/electron && npm run build`
Expected: build succeeds (no missing-export or type errors from the badge/tool changes).

- [ ] **Step 4: Manual smoke (optional, requires a packaged run)**

Launch the app. Confirm the top-right shows a slim `vX.Y.Z ✓` at traffic-light height (no glass pill), that hovering highlights it, and that clicking it runs a check (glyph briefly becomes the spinner). In a dev run the badge shows the version with a checkmark and clicking is a harmless no-op.
