# Voice Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working FamilyHub assistant slice with household members, Google diarization session-label gating, and an Electron UI for enrollment/listening state.

**Architecture:** Keep vendor APIs behind main-process adapters and implement deterministic core logic first. The renderer captures user intent and displays state; the preload bridge exposes a small IPC surface; the main process owns storage, gating, and service orchestration. The MVP includes simulated vendor adapters when credentials are absent so the app remains usable and verifiable locally.

**Tech Stack:** Electron 42, React 19, TypeScript 6, Vite/electron-vite, Vitest for pure logic tests, Node filesystem storage.

---

## File Structure

- Create `apps/electron/src/main/assistant/types.ts`: shared assistant domain types.
- Create `apps/electron/src/main/assistant/config.ts`: environment-based provider configuration status.
- Create `apps/electron/src/main/assistant/profileStore.ts`: file-backed enrolled speaker metadata/profile storage.
- Create `apps/electron/src/main/assistant/turns.ts`: Google diarized word grouping into turns.
- Create `apps/electron/src/main/assistant/gating.ts`: Google diarization session-label gate.
- Create `apps/electron/src/main/assistant/service.ts`: assistant state machine and fakeable vendor boundaries.
- Create `apps/electron/src/main/assistant/ipc.ts`: IPC registration for assistant commands/events.
- Modify `apps/electron/src/main/index.ts`: register assistant IPC and pass `app.getPath("userData")`.
- Modify `apps/electron/src/preload/index.ts`: expose `window.familyHub.assistant`.
- Modify `apps/electron/src/renderer/src/vite-env.d.ts`: bridge types.
- Modify `apps/electron/src/renderer/src/App.tsx`: assistant dashboard UI.
- Modify `apps/electron/src/renderer/src/styles.css`: dashboard styling.
- Modify `apps/electron/package.json`: add Vitest test script and dependency.
- Create tests beside the new main-process assistant modules.

## Task 1: Test Harness and Core Domain Logic

**Files:**
- Modify: `apps/electron/package.json`
- Create: `apps/electron/src/main/assistant/types.ts`
- Create: `apps/electron/src/main/assistant/gating.ts`
- Create: `apps/electron/src/main/assistant/gating.test.ts`
- Create: `apps/electron/src/main/assistant/turns.ts`
- Create: `apps/electron/src/main/assistant/turns.test.ts`

- [ ] Add Vitest to the Electron workspace and add `"test": "vitest run"` to `apps/electron/package.json`.
- [ ] Write failing tests for accepted, disabled, unknown, and low-confidence speaker decisions in `gating.test.ts`.
- [ ] Run `npm run test --workspace=@family-hub/electron -- gating.test.ts`; expect failures because `gating.ts` does not exist yet.
- [ ] Implement `types.ts` and `gating.ts` with `selectVerifiedSpeaker`.
- [ ] Run the gating tests and verify they pass.
- [ ] Write failing tests for grouping diarized words into speaker turns in `turns.test.ts`.
- [ ] Run `npm run test --workspace=@family-hub/electron -- turns.test.ts`; expect failures because `turns.ts` does not exist yet.
- [ ] Implement `groupDiarizedWordsIntoTurns`.
- [ ] Run all Electron tests and verify they pass.

## Task 2: Persistent Speaker Profile Storage

**Files:**
- Create: `apps/electron/src/main/assistant/profileStore.ts`
- Create: `apps/electron/src/main/assistant/profileStore.test.ts`

- [ ] Write failing tests for empty store loading, creating a speaker with profile bytes, toggling allowed state, deleting a speaker, and reloading persisted metadata.
- [ ] Run `npm run test --workspace=@family-hub/electron -- profileStore.test.ts`; expect failures because `profileStore.ts` does not exist yet.
- [ ] Implement `FileSpeakerProfileStore` using `node:fs/promises`, storing metadata in `speaker-profiles/speakers.json` and profile bytes in `<id>.eagle`.
- [ ] Run all Electron tests and verify they pass.

## Task 3: Assistant Service State Machine

**Files:**
- Create: `apps/electron/src/main/assistant/config.ts`
- Create: `apps/electron/src/main/assistant/service.ts`
- Create: `apps/electron/src/main/assistant/service.test.ts`

- [ ] Write failing tests for missing config status, enrollment creating a stored speaker, disabled listening with no speakers, accepted transcript forwarding to Gemini, and rejected transcript not forwarding.
- [ ] Run `npm run test --workspace=@family-hub/electron -- service.test.ts`; expect failures because service modules do not exist yet.
- [ ] Implement `readAssistantConfigStatus`, `AssistantService`, and fakeable `SpeakerRecognizerAdapter`, `TranscriptionAdapter`, and `GeminiLiveAdapter` interfaces.
- [ ] Run all Electron tests and verify they pass.

## Task 4: Electron IPC and Preload Bridge

**Files:**
- Create: `apps/electron/src/main/assistant/ipc.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/src/vite-env.d.ts`

- [ ] Register assistant IPC handlers for config, speaker list, enrollment simulation, allowed toggle, delete, start/stop listening, and simulated transcript submission.
- [ ] Expose matching preload methods under `window.familyHub.assistant`.
- [ ] Update renderer bridge types to match the preload API.
- [ ] Run `npm run typecheck --workspace=@family-hub/electron`; expect any type errors to identify bridge mismatches.
- [ ] Fix type errors and rerun typecheck.

## Task 5: Assistant Dashboard UI

**Files:**
- Modify: `apps/electron/src/renderer/src/App.tsx`
- Modify: `apps/electron/src/renderer/src/styles.css`

- [ ] Replace placeholder setup content with assistant dashboard sections for provider config, enrollment, speaker list, live controls, transcript simulation, and assistant event log.
- [ ] Use stable responsive layout constraints and clear disabled states.
- [ ] Run `npm run typecheck --workspace=@family-hub/electron` and `npm run lint --workspace=@family-hub/electron`.
- [ ] Fix any UI type/lint issues.

## Task 6: Final Verification

**Files:**
- Verify all changed files.

- [ ] Run `npm run test --workspace=@family-hub/electron`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Report exactly what was implemented, which commands passed, and note that real Google/Gemini SDK streaming is represented by adapter boundaries in this MVP.
