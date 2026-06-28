# Family Voice Enrollment (SP1: capture + storage + UI) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-app Family Setup flow where each member records ~15 "Hey James" samples, stored on-device as 16 kHz PCM16 WAV per member, with wake paused during setup. No wake-behavior change (SP2 reads these clips to personalize recall).

**Architecture:** New focused units following existing patterns — a pure `pcm16ToWav` (`wav.ts`), a temp-dir-tested `enrollmentStore.ts` (member + clip CRUD), a pure `enrollmentMachine.ts` reducer (record→review→keep/redo/next, mirroring `listenerMachine.ts`), a `recordClip()` capture helper in `audioClip.ts`, an `enrollment` IPC/preload/types bridge, and thin React Views (`EnrollmentRecorder.tsx`, `FamilySetup.tsx`) asserted via `renderToStaticMarkup`, wired into `App.tsx` with pause/resume.

**Tech Stack:** Electron (main/preload/renderer), TypeScript (strict, `exactOptionalPropertyTypes` on), React, `vitest` (NO React Testing Library — pure logic + `react-dom/server` `renderToStaticMarkup`).

## Global Constraints

- **No React Testing Library.** Tests are `vitest`. Test pure logic directly; assert React output with `renderToStaticMarkup` from `react-dom/server`. Mirror `UpdateControl.tsx`/`UpdateControl.test.tsx` (View + pure helpers) and `listenerMachine.ts`/`listenerMachine.test.ts` (pure reducer).
- **TypeScript strict + `exactOptionalPropertyTypes`.** Optional fields use `field?: T` and are omitted (not set to `undefined`) when absent.
- **Run tests from `apps/electron`:** `npm test` (= `vitest run`) runs the whole renderer+main suite; while iterating run a single file: `npx vitest run src/<path>/<file>.test.ts`. Typecheck: `npm run typecheck`.
- **Clip format is fixed:** 16 kHz, mono, int16 PCM; WAV is 44-byte header + PCM data. Identical to wake/embedding inputs.
- **IPC pattern (follow exactly):** request = `ipcRenderer.invoke("enrollment:<action>")` ↔ `ipcMain.handle` in `ipc.ts`; push = `makeSubscription("enrollment:members")` ↔ `webContents.send`. Preload exposes under `window.familyHub.enrollment`. Renderer types live in `renderer/src/vite-env.d.ts`.
- **Storage root:** `<app.getPath("userData")>/speaker-profiles/<memberId>/` — `clips/clip_NNNN.wav` + `member.json` (`{id,name}`). The store takes its base dir as a constructor arg so tests use a temp dir.
- **SP1 must not touch the wake path** (`sidecar/wake_listener.py`, the wake engine) — pause/resume only via existing `startListening`/`stopListening`.

---

### Task 1: Pure `pcm16ToWav` (`wav.ts`)

**Files:**
- Create: `apps/electron/src/main/assistant/wav.ts`
- Create: `apps/electron/src/main/assistant/wav.test.ts`

**Interfaces:**
- Produces: `pcm16ToWav(samples: Int16Array, sampleRate: number): Buffer` — a canonical 44-byte-header mono 16-bit PCM WAV.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/electron/src/main/assistant/wav.test.ts
import { describe, expect, it } from "vitest";
import { pcm16ToWav } from "./wav";

describe("pcm16ToWav", () => {
  it("writes a 44-byte header + 2 bytes per sample", () => {
    const buf = pcm16ToWav(new Int16Array([0, 1, -1, 32767, -32768]), 16000);
    expect(buf.length).toBe(44 + 5 * 2);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.toString("ascii", 12, 16)).toBe("fmt ");
    expect(buf.toString("ascii", 36, 40)).toBe("data");
  });
  it("encodes fmt fields: PCM mono 16-bit @ given rate", () => {
    const buf = pcm16ToWav(new Int16Array([7]), 16000);
    expect(buf.readUInt16LE(20)).toBe(1); // audioFormat = PCM
    expect(buf.readUInt16LE(22)).toBe(1); // channels = mono
    expect(buf.readUInt32LE(24)).toBe(16000); // sampleRate
    expect(buf.readUInt32LE(28)).toBe(16000 * 2); // byteRate = rate*blockAlign
    expect(buf.readUInt16LE(32)).toBe(2); // blockAlign
    expect(buf.readUInt16LE(34)).toBe(16); // bitsPerSample
    expect(buf.readUInt32LE(40)).toBe(2); // data chunk size = 1 sample * 2
    expect(buf.readInt16LE(44)).toBe(7); // the sample
  });
  it("sets RIFF chunk size to 36 + data length", () => {
    const buf = pcm16ToWav(new Int16Array([1, 2, 3]), 16000);
    expect(buf.readUInt32LE(4)).toBe(36 + 3 * 2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/electron && npx vitest run src/main/assistant/wav.test.ts`
Expected: FAIL — cannot find module `./wav`.

- [ ] **Step 3: Implement `wav.ts`**

```typescript
// apps/electron/src/main/assistant/wav.ts
// Pure: encode int16 mono PCM as a canonical 44-byte-header WAV. No I/O.
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Buffer {
  const blockAlign = 2; // mono * 16-bit
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28); // byteRate
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/electron && npx vitest run src/main/assistant/wav.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/assistant/wav.ts apps/electron/src/main/assistant/wav.test.ts
git commit -m "feat(enrollment): pure pcm16ToWav encoder"
```

---

### Task 2: `enrollmentStore.ts` — member + clip storage

**Files:**
- Create: `apps/electron/src/main/assistant/enrollmentStore.ts`
- Create: `apps/electron/src/main/assistant/enrollmentStore.test.ts`

**Interfaces:**
- Consumes: `pcm16ToWav` (Task 1).
- Produces: `EnrolledMember = { id: string; name: string; sampleCount: number }`, and class `EnrollmentStore` constructed with a base dir:
  - `addMember(name: string): EnrolledMember` (throws on empty/whitespace name)
  - `listMembers(): EnrolledMember[]`
  - `deleteMember(id: string): void`
  - `saveClip(id: string, pcm16: Int16Array): { sampleCount: number }`
  - `deleteLastClip(id: string): { sampleCount: number }`
  - `clipsDir(id: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/electron/src/main/assistant/enrollmentStore.test.ts
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnrollmentStore } from "./enrollmentStore";

function freshStore() {
  return new EnrollmentStore(mkdtempSync(join(tmpdir(), "enroll-")));
}

describe("EnrollmentStore", () => {
  it("adds a member, lists it with zero samples", () => {
    const s = freshStore();
    const m = s.addMember("Mom");
    expect(m.name).toBe("Mom");
    expect(m.sampleCount).toBe(0);
    expect(s.listMembers().map((x) => x.name)).toEqual(["Mom"]);
  });
  it("rejects an empty/whitespace name", () => {
    const s = freshStore();
    expect(() => s.addMember("   ")).toThrow();
  });
  it("saves clips, increments count, writes wav files", () => {
    const s = freshStore();
    const m = s.addMember("Dad");
    expect(s.saveClip(m.id, new Int16Array([1, 2, 3])).sampleCount).toBe(1);
    expect(s.saveClip(m.id, new Int16Array([4, 5])).sampleCount).toBe(2);
    const files = readdirSync(s.clipsDir(m.id)).filter((f) => f.endsWith(".wav"));
    expect(files.length).toBe(2);
    expect(files).toContain("clip_0000.wav");
    expect(files).toContain("clip_0001.wav");
  });
  it("deleteLastClip decrements and removes the highest-index clip", () => {
    const s = freshStore();
    const m = s.addMember("Kid");
    s.saveClip(m.id, new Int16Array([1]));
    s.saveClip(m.id, new Int16Array([2]));
    expect(s.deleteLastClip(m.id).sampleCount).toBe(1);
    expect(readdirSync(s.clipsDir(m.id))).toContain("clip_0000.wav");
    expect(readdirSync(s.clipsDir(m.id))).not.toContain("clip_0001.wav");
  });
  it("next index is max existing + 1 (no clobber after a delete in the middle)", () => {
    const s = freshStore();
    const m = s.addMember("X");
    s.saveClip(m.id, new Int16Array([1])); // 0000
    s.saveClip(m.id, new Int16Array([2])); // 0001
    s.deleteLastClip(m.id); // removes 0001
    s.saveClip(m.id, new Int16Array([3])); // must be 0001 again (max 0000 + 1)
    expect(readdirSync(s.clipsDir(m.id)).sort()).toEqual(["clip_0000.wav", "clip_0001.wav"]);
  });
  it("deleteMember removes the dir", () => {
    const s = freshStore();
    const m = s.addMember("Gone");
    const dir = s.clipsDir(m.id);
    s.deleteMember(m.id);
    expect(existsSync(dir)).toBe(false);
    expect(s.listMembers()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/electron && npx vitest run src/main/assistant/enrollmentStore.test.ts`
Expected: FAIL — cannot find module `./enrollmentStore`.

- [ ] **Step 3: Implement `enrollmentStore.ts`**

```typescript
// apps/electron/src/main/assistant/enrollmentStore.ts
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pcm16ToWav } from "./wav";

export interface EnrolledMember {
  id: string;
  name: string;
  sampleCount: number;
}

const SAMPLE_RATE = 16000;

export class EnrollmentStore {
  constructor(private readonly baseDir: string) {}

  private memberDir(id: string): string {
    return join(this.baseDir, id);
  }
  clipsDir(id: string): string {
    return join(this.memberDir(id), "clips");
  }
  private metaPath(id: string): string {
    return join(this.memberDir(id), "member.json");
  }

  private slug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "member";
  }

  addMember(name: string): EnrolledMember {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("member name required");
    // id = slug + short nonce derived from existing count, collision-safe within this store
    let id = this.slug(trimmed);
    let n = 1;
    while (existsSync(this.memberDir(id))) id = `${this.slug(trimmed)}-${n++}`;
    mkdirSync(this.clipsDir(id), { recursive: true });
    writeFileSync(this.metaPath(id), JSON.stringify({ id, name: trimmed }));
    return { id, name: trimmed, sampleCount: 0 };
  }

  private sampleCount(id: string): number {
    const dir = this.clipsDir(id);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".wav")).length;
  }

  listMembers(): EnrolledMember[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((d) => existsSync(this.metaPath(d)))
      .map((d) => {
        const meta = JSON.parse(readFileSync(this.metaPath(d), "utf8")) as { id: string; name: string };
        return { id: meta.id, name: meta.name, sampleCount: this.sampleCount(d) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  deleteMember(id: string): void {
    rmSync(this.memberDir(id), { recursive: true, force: true });
  }

  private nextIndex(id: string): number {
    const dir = this.clipsDir(id);
    if (!existsSync(dir)) return 0;
    const nums = readdirSync(dir)
      .map((f) => /^clip_(\d+)\.wav$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) + 1 : 0;
  }

  saveClip(id: string, pcm16: Int16Array): { sampleCount: number } {
    const dir = this.clipsDir(id);
    mkdirSync(dir, { recursive: true });
    const index = this.nextIndex(id);
    const name = `clip_${String(index).padStart(4, "0")}.wav`;
    writeFileSync(join(dir, name), pcm16ToWav(pcm16, SAMPLE_RATE));
    return { sampleCount: this.sampleCount(id) };
  }

  deleteLastClip(id: string): { sampleCount: number } {
    const dir = this.clipsDir(id);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => /^clip_\d+\.wav$/.test(f)).sort();
      const last = files[files.length - 1];
      if (last) rmSync(join(dir, last));
    }
    return { sampleCount: this.sampleCount(id) };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/electron && npx vitest run src/main/assistant/enrollmentStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/assistant/enrollmentStore.ts apps/electron/src/main/assistant/enrollmentStore.test.ts
git commit -m "feat(enrollment): on-disk member + clip store"
```

---

### Task 3: `enrollmentMachine.ts` — pure recording-flow reducer

**Files:**
- Create: `apps/electron/src/renderer/src/enrollmentMachine.ts`
- Create: `apps/electron/src/renderer/src/enrollmentMachine.test.ts`

**Interfaces:**
- Produces (mirrors `listenerMachine` shape):
  - `EnrollmentState = { phase: "idle" | "recording" | "review"; target: number; kept: number; hasClip: boolean }`
  - `EnrollmentEvent = {type:"startRecord"} | {type:"clipCaptured"} | {type:"keep"} | {type:"redo"} | {type:"reset", kept:number}`
  - `createEnrollmentState(target: number, kept: number): EnrollmentState`
  - `reduceEnrollment(state, event): EnrollmentState` (pure)
  - `isComplete(state): boolean` (`kept >= target`)
  Note: the reducer tracks flow phase + counts only; actual record/save side-effects are performed by the View using `recordClip`/IPC (the reducer stays pure and asserts the transitions).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/electron/src/renderer/src/enrollmentMachine.test.ts
import { describe, expect, it } from "vitest";
import {
  createEnrollmentState, reduceEnrollment, isComplete,
} from "./enrollmentMachine";

describe("enrollmentMachine", () => {
  it("starts idle with the given kept count", () => {
    const s = createEnrollmentState(15, 3);
    expect(s).toMatchObject({ phase: "idle", target: 15, kept: 3, hasClip: false });
  });
  it("startRecord → recording", () => {
    const s = reduceEnrollment(createEnrollmentState(15, 0), { type: "startRecord" });
    expect(s.phase).toBe("recording");
  });
  it("clipCaptured → review with a clip", () => {
    let s = reduceEnrollment(createEnrollmentState(15, 0), { type: "startRecord" });
    s = reduceEnrollment(s, { type: "clipCaptured" });
    expect(s).toMatchObject({ phase: "review", hasClip: true });
  });
  it("keep → kept+1, back to idle, clip cleared", () => {
    let s = createEnrollmentState(15, 0);
    s = reduceEnrollment(s, { type: "startRecord" });
    s = reduceEnrollment(s, { type: "clipCaptured" });
    s = reduceEnrollment(s, { type: "keep" });
    expect(s).toMatchObject({ phase: "idle", kept: 1, hasClip: false });
  });
  it("redo → back to recording, clip discarded, kept unchanged", () => {
    let s = createEnrollmentState(15, 2);
    s = reduceEnrollment(s, { type: "startRecord" });
    s = reduceEnrollment(s, { type: "clipCaptured" });
    s = reduceEnrollment(s, { type: "redo" });
    expect(s).toMatchObject({ phase: "recording", kept: 2, hasClip: false });
  });
  it("reset syncs kept from the store and returns to idle", () => {
    let s = reduceEnrollment(createEnrollmentState(15, 0), { type: "startRecord" });
    s = reduceEnrollment(s, { type: "reset", kept: 7 });
    expect(s).toMatchObject({ phase: "idle", kept: 7, hasClip: false });
  });
  it("isComplete at/over target", () => {
    expect(isComplete(createEnrollmentState(15, 15))).toBe(true);
    expect(isComplete(createEnrollmentState(15, 14))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/electron && npx vitest run src/renderer/src/enrollmentMachine.test.ts`
Expected: FAIL — cannot find module `./enrollmentMachine`.

- [ ] **Step 3: Implement `enrollmentMachine.ts`**

```typescript
// apps/electron/src/renderer/src/enrollmentMachine.ts
// Pure reducer for the per-member guided recorder. Side effects (record/save)
// are performed by the View on each transition; this stays pure + testable,
// mirroring listenerMachine.ts.
export interface EnrollmentState {
  phase: "idle" | "recording" | "review";
  target: number;
  kept: number;
  hasClip: boolean;
}

export type EnrollmentEvent =
  | { type: "startRecord" }
  | { type: "clipCaptured" }
  | { type: "keep" }
  | { type: "redo" }
  | { type: "reset"; kept: number };

export function createEnrollmentState(target: number, kept: number): EnrollmentState {
  return { phase: "idle", target, kept, hasClip: false };
}

export function reduceEnrollment(state: EnrollmentState, event: EnrollmentEvent): EnrollmentState {
  switch (event.type) {
    case "startRecord":
      return { ...state, phase: "recording", hasClip: false };
    case "clipCaptured":
      return { ...state, phase: "review", hasClip: true };
    case "keep":
      return { ...state, phase: "idle", kept: state.kept + 1, hasClip: false };
    case "redo":
      return { ...state, phase: "recording", hasClip: false };
    case "reset":
      return { ...state, phase: "idle", kept: event.kept, hasClip: false };
    default:
      return state;
  }
}

export function isComplete(state: EnrollmentState): boolean {
  return state.kept >= state.target;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/electron && npx vitest run src/renderer/src/enrollmentMachine.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/renderer/src/enrollmentMachine.ts apps/electron/src/renderer/src/enrollmentMachine.test.ts
git commit -m "feat(enrollment): pure recording-flow reducer"
```

---

### Task 4: `recordClip()` + fixed-window helper (`audioClip.ts`)

**Files:**
- Modify: `apps/electron/src/renderer/src/audioClip.ts` (add `accumulateWindow` pure helper + `recordClip`)
- Modify: `apps/electron/src/renderer/src/audioClip.test.ts` (add helper tests)

**Interfaces:**
- Consumes: existing `int16ToBase64`, `convertFloatSamplesToLinear16` in `audioClip.ts`.
- Produces:
  - `windowSampleCount(seconds: number, sampleRate: number): number` (= `Math.round(seconds * sampleRate)`)
  - `accumulateWindow(chunks: Float32Array[], needed: number): { done: boolean; samples: number }` — pure: reports whether the buffered chunks reached `needed` samples and how many are buffered.
  - `recordClip(opts?: { seconds?: number; deviceId?: string }): Promise<Int16Array>` — captures a fixed window of 16 kHz int16 from the mic and resolves it. (Web-Audio glue; not unit-tested directly — the accumulation math is the tested part.)

- [ ] **Step 1: Write the failing test (read the current `audioClip.ts` first to match style)**

```typescript
// add to apps/electron/src/renderer/src/audioClip.test.ts
import { windowSampleCount, accumulateWindow } from "./audioClip";

describe("recordClip windowing", () => {
  it("windowSampleCount = round(seconds * rate)", () => {
    expect(windowSampleCount(2, 16000)).toBe(32000);
    expect(windowSampleCount(1.5, 16000)).toBe(24000);
  });
  it("accumulateWindow reports done only once the window is filled", () => {
    const a = accumulateWindow([new Float32Array(10000)], 32000);
    expect(a).toEqual({ done: false, samples: 10000 });
    const b = accumulateWindow([new Float32Array(20000), new Float32Array(20000)], 32000);
    expect(b.done).toBe(true);
    expect(b.samples).toBe(40000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/electron && npx vitest run src/renderer/src/audioClip.test.ts`
Expected: FAIL — `windowSampleCount`/`accumulateWindow` not exported.

- [ ] **Step 3: Implement the helpers + `recordClip` (append to `audioClip.ts`)**

```typescript
// apps/electron/src/renderer/src/audioClip.ts  (append)
export function windowSampleCount(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

export function accumulateWindow(
  chunks: Float32Array[],
  needed: number,
): { done: boolean; samples: number } {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  return { done: samples >= needed, samples };
}

const CAPTURE_RATE = 16000;

// Capture a fixed ~`seconds` window of 16 kHz mono int16 from the mic, then tear
// the graph down. Mirrors App.tsx's capture setup but accumulates a window
// instead of streaming. The accumulation math is windowSampleCount/accumulateWindow.
export async function recordClip(opts?: { seconds?: number; deviceId?: string }): Promise<Int16Array> {
  const seconds = opts?.seconds ?? 2;
  const needed = windowSampleCount(seconds, CAPTURE_RATE);
  const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: false };
  if (opts?.deviceId) audio.deviceId = { exact: opts.deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  const ctx = new Ctor({ sampleRate: CAPTURE_RATE });
  try {
    await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    const muted = ctx.createGain();
    muted.gain.value = 0;
    const chunks: Float32Array[] = [];
    const done = new Promise<void>((resolve) => {
      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        if (accumulateWindow(chunks, needed).done) resolve();
      };
    });
    source.connect(processor);
    processor.connect(muted);
    muted.connect(ctx.destination);
    await done;
    const flat: number[] = [];
    for (const c of chunks) for (const s of c) { flat.push(s); if (flat.length >= needed) break; }
    return convertFloatSamplesToLinear16(flat.slice(0, needed));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/electron && npx vitest run src/renderer/src/audioClip.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/renderer/src/audioClip.ts apps/electron/src/renderer/src/audioClip.test.ts
git commit -m "feat(enrollment): fixed-window recordClip + pure windowing helpers"
```

---

### Task 5: Enrollment IPC + preload + renderer types

**Files:**
- Modify: `apps/electron/src/main/assistant/ipc.ts` (register `enrollment:*` handlers; construct one `EnrollmentStore`; push `enrollment:members`)
- Modify: `apps/electron/src/preload/index.ts` (add `enrollment` bridge)
- Modify: `apps/electron/src/renderer/src/vite-env.d.ts` (`EnrolledMember`, `EnrollmentBridge`, add to `FamilyHubBridge`)
- Create: `apps/electron/src/main/assistant/enrollmentIpc.ts` (pure helper: `decodePcm16(base64): Int16Array`) + `apps/electron/src/main/assistant/enrollmentIpc.test.ts`

**Interfaces:**
- Consumes: `EnrollmentStore`, `EnrolledMember` (Task 2).
- Produces:
  - main pure helper `decodePcm16(base64: string): Int16Array` (base64 → Int16Array, used by the `saveClip` handler).
  - IPC channels (all `ipcMain.handle`): `enrollment:listMembers` → `EnrolledMember[]`; `enrollment:addMember` (name) → `EnrolledMember[]`; `enrollment:deleteMember` (id) → `EnrolledMember[]`; `enrollment:saveClip` (id, base64) → `{ sampleCount }`; `enrollment:deleteLastClip` (id) → `{ sampleCount }`. After any mutation, `webContents.send("enrollment:members", members)`.
  - preload `window.familyHub.enrollment`: `listMembers()`, `addMember(name)`, `deleteMember(id)`, `saveClip(id, base64)`, `deleteLastClip(id)`, `onMembers(cb)`.

- [ ] **Step 1: Write the failing test for the pure decode helper**

```typescript
// apps/electron/src/main/assistant/enrollmentIpc.test.ts
import { describe, expect, it } from "vitest";
import { decodePcm16 } from "./enrollmentIpc";
import { int16ToBase64 } from "../../renderer/src/audioClip";

describe("decodePcm16", () => {
  it("round-trips an int16 array through base64", () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
    const decoded = decodePcm16(int16ToBase64(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
  it("returns empty for empty base64", () => {
    expect(decodePcm16("").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/electron && npx vitest run src/main/assistant/enrollmentIpc.test.ts`
Expected: FAIL — cannot find module `./enrollmentIpc`.

- [ ] **Step 3: Implement `enrollmentIpc.ts` (pure helper)**

```typescript
// apps/electron/src/main/assistant/enrollmentIpc.ts
// Pure: decode renderer base64 (int16 LE PCM) to Int16Array. Mirrors the
// renderer's base64ToInt16 but lives main-side for the saveClip handler.
export function decodePcm16(base64: string): Int16Array {
  if (!base64) return new Int16Array(0);
  const bytes = Buffer.from(base64, "base64");
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/electron && npx vitest run src/main/assistant/enrollmentIpc.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the IPC handlers in `ipc.ts`**

FIRST read `ipc.ts`: it imports `{ ipcMain, type WebContents }` (NOT `app`), exposes `registerAssistantIpc(...)` (called ONCE at startup), and pushes to the renderer via `event.sender.send(channel, ...)` inside handlers (e.g. `assistant:startListening`), NOT a captured `webContents`. So: (a) add `app` to the electron import; (b) register the enrollment handlers at the same single call site as `registerAssistantIpc` (since `ipcMain.handle` throws on a duplicate channel, they must be registered exactly once — confirm `registerAssistantIpc` is invoked once); (c) push with `event.sender.send`. Construct one store at `join(app.getPath("userData"), "speaker-profiles")`:

```typescript
// change the existing import to: import { app, ipcMain, type WebContents } from "electron";
import { join } from "node:path";
import { EnrollmentStore } from "./enrollmentStore";
import { decodePcm16 } from "./enrollmentIpc";

// Inside the single registration path (alongside the assistant handlers, or a
// sibling registerEnrollmentIpc() called once from the same site):
const enrollment = new EnrollmentStore(join(app.getPath("userData"), "speaker-profiles"));

ipcMain.handle("enrollment:listMembers", () => enrollment.listMembers());
ipcMain.handle("enrollment:addMember", (event, name: string) => {
  enrollment.addMember(name);
  const members = enrollment.listMembers();
  event.sender.send("enrollment:members", members);
  return members;
});
ipcMain.handle("enrollment:deleteMember", (event, id: string) => {
  enrollment.deleteMember(id);
  const members = enrollment.listMembers();
  event.sender.send("enrollment:members", members);
  return members;
});
ipcMain.handle("enrollment:saveClip", (event, id: string, base64: string) => {
  const result = enrollment.saveClip(id, decodePcm16(base64));
  event.sender.send("enrollment:members", enrollment.listMembers());
  return result;
});
ipcMain.handle("enrollment:deleteLastClip", (event, id: string) => {
  const result = enrollment.deleteLastClip(id);
  event.sender.send("enrollment:members", enrollment.listMembers());
  return result;
});
```

(Do not add a second window/webContents lookup — reuse `event.sender` exactly as the existing `assistant:*` handlers do. If `registerAssistantIpc` turns out to be called per-window, register the enrollment channels guarded so they bind only once.)

- [ ] **Step 6: Add the preload bridge in `preload/index.ts`**

```typescript
  enrollment: {
    listMembers: () => ipcRenderer.invoke("enrollment:listMembers") as Promise<unknown>,
    addMember: (name: string) => ipcRenderer.invoke("enrollment:addMember", name) as Promise<unknown>,
    deleteMember: (id: string) => ipcRenderer.invoke("enrollment:deleteMember", id) as Promise<unknown>,
    saveClip: (id: string, base64: string) => ipcRenderer.invoke("enrollment:saveClip", id, base64) as Promise<unknown>,
    deleteLastClip: (id: string) => ipcRenderer.invoke("enrollment:deleteLastClip", id) as Promise<unknown>,
    onMembers: makeSubscription("enrollment:members"),
  },
```

- [ ] **Step 7: Add renderer types in `vite-env.d.ts`**

```typescript
interface EnrolledMember {
  id: string;
  name: string;
  sampleCount: number;
}
interface EnrollmentBridge {
  listMembers: () => Promise<EnrolledMember[]>;
  addMember: (name: string) => Promise<EnrolledMember[]>;
  deleteMember: (id: string) => Promise<EnrolledMember[]>;
  saveClip: (id: string, base64: string) => Promise<{ sampleCount: number }>;
  deleteLastClip: (id: string) => Promise<{ sampleCount: number }>;
  onMembers: (cb: (members: EnrolledMember[]) => void) => () => void;
}
// add to FamilyHubBridge:
//   enrollment: EnrollmentBridge;
```

- [ ] **Step 8: Typecheck + decode test**

Run: `cd apps/electron && npm run typecheck && npx vitest run src/main/assistant/enrollmentIpc.test.ts`
Expected: typecheck passes; decode test PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/electron/src/main/assistant/ipc.ts apps/electron/src/main/assistant/enrollmentIpc.ts apps/electron/src/main/assistant/enrollmentIpc.test.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/src/vite-env.d.ts
git commit -m "feat(enrollment): IPC + preload bridge + renderer types"
```

---

### Task 6: `EnrollmentRecorder` + `FamilySetup` Views

**Files:**
- Create: `apps/electron/src/renderer/src/EnrollmentRecorder.tsx`
- Create: `apps/electron/src/renderer/src/EnrollmentRecorder.test.tsx`
- Create: `apps/electron/src/renderer/src/FamilySetup.tsx`
- Create: `apps/electron/src/renderer/src/FamilySetup.test.tsx`

**Interfaces:**
- Consumes: `enrollmentMachine` (Task 3), `recordClip` + `int16ToBase64` (Task 4), `window.familyHub.enrollment` (Task 5).
- Produces:
  - pure `recorderView(args): string-bearing props` and `<EnrollmentRecorderView>` (asserted via `renderToStaticMarkup`).
  - pure `memberRowLabel(member, target): string` (e.g. `"Mom — 15/15 ✓"` or `"Dad — 4/15"`).
  - `<EnrollmentRecorder member target onClose>` and `<FamilySetup onClose>` containers (use `useState`/the machine + injected effects; the container is thin, the pure bits carry the tests).

- [ ] **Step 1: Write the failing tests (Views, via renderToStaticMarkup)**

```tsx
// apps/electron/src/renderer/src/EnrollmentRecorder.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnrollmentRecorderView, recorderPrompt } from "./EnrollmentRecorder";

describe("recorderPrompt", () => {
  it("shows sample n/N and the phrase while idle", () => {
    expect(recorderPrompt({ phase: "idle", target: 15, kept: 3, hasClip: false }))
      .toMatchObject({ counter: "4 / 15", action: "Record" });
  });
  it("prompts to keep/redo in review", () => {
    expect(recorderPrompt({ phase: "review", target: 15, kept: 3, hasClip: true }).action)
      .toBe("Keep or redo");
  });
});

describe("EnrollmentRecorderView", () => {
  it("renders the phrase 'Hey James' and the counter", () => {
    const html = renderToStaticMarkup(
      <EnrollmentRecorderView state={{ phase: "idle", target: 15, kept: 0, hasClip: false }}
        memberName="Mom" onRecord={() => {}} onKeep={() => {}} onRedo={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("Hey James");
    expect(html).toContain("1 / 15");
    expect(html).toContain("Mom");
  });
});
```

```tsx
// apps/electron/src/renderer/src/FamilySetup.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FamilySetupView, memberRowLabel } from "./FamilySetup";

describe("memberRowLabel", () => {
  it("marks complete members", () => {
    expect(memberRowLabel({ id: "a", name: "Mom", sampleCount: 15 }, 15)).toBe("Mom — 15/15 ✓");
  });
  it("shows progress for under-enrolled", () => {
    expect(memberRowLabel({ id: "b", name: "Dad", sampleCount: 4 }, 15)).toBe("Dad — 4/15");
  });
});

describe("FamilySetupView", () => {
  it("lists members and an add control", () => {
    const html = renderToStaticMarkup(
      <FamilySetupView members={[{ id: "a", name: "Mom", sampleCount: 15 }]} target={15}
        onAdd={() => {}} onDelete={() => {}} onEnroll={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("Mom — 15/15 ✓");
    expect(html).toContain("Add member");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/electron && npx vitest run src/renderer/src/EnrollmentRecorder.test.tsx src/renderer/src/FamilySetup.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `EnrollmentRecorder.tsx`**

```tsx
// apps/electron/src/renderer/src/EnrollmentRecorder.tsx
import { useCallback, useRef, useState } from "react";
import { createEnrollmentState, isComplete, reduceEnrollment, type EnrollmentState } from "./enrollmentMachine";
import { recordClip, int16ToBase64 } from "./audioClip";

export function recorderPrompt(state: EnrollmentState): { counter: string; action: string } {
  const counter = `${Math.min(state.kept + 1, state.target)} / ${state.target}`;
  if (state.phase === "review") return { counter, action: "Keep or redo" };
  if (state.phase === "recording") return { counter, action: "Listening…" };
  return { counter, action: "Record" };
}

export function EnrollmentRecorderView(props: {
  state: EnrollmentState; memberName: string;
  onRecord: () => void; onKeep: () => void; onRedo: () => void; onClose: () => void;
}): JSX.Element {
  const { counter, action } = recorderPrompt(props.state);
  return (
    <div className="enroll-recorder">
      <header><h3>{props.memberName}</h3><button onClick={props.onClose}>Done</button></header>
      <p className="enroll-counter">{counter}</p>
      <p className="enroll-phrase">Say: “Hey James”</p>
      <p className="enroll-action">{action}</p>
      {props.state.phase === "idle" && <button onClick={props.onRecord}>Record</button>}
      {props.state.phase === "review" && (
        <div><button onClick={props.onKeep}>Keep</button><button onClick={props.onRedo}>Redo</button></div>
      )}
      {isComplete(props.state) && <p className="enroll-done">All set — {props.state.target} samples ✓</p>}
    </div>
  );
}

export function EnrollmentRecorder(props: { memberId: string; memberName: string; target: number; kept: number; onClose: () => void; onChange?: (kept: number) => void; }): JSX.Element {
  const [state, setState] = useState<EnrollmentState>(() => createEnrollmentState(props.target, props.kept));
  const pcmRef = useRef<Int16Array | null>(null);

  const onRecord = useCallback(async () => {
    setState((s) => reduceEnrollment(s, { type: "startRecord" }));
    try {
      pcmRef.current = await recordClip({ seconds: 2 });
      setState((s) => reduceEnrollment(s, { type: "clipCaptured" }));
    } catch {
      setState((s) => reduceEnrollment(s, { type: "redo" }));
    }
  }, []);
  const onKeep = useCallback(async () => {
    if (pcmRef.current) {
      const { sampleCount } = await window.familyHub.enrollment.saveClip(props.memberId, int16ToBase64(pcmRef.current));
      props.onChange?.(sampleCount);
      setState((s) => reduceEnrollment({ ...s, kept: sampleCount - 1 }, { type: "keep" }));
    }
    pcmRef.current = null;
  }, [props]);
  const onRedo = useCallback(() => { pcmRef.current = null; setState((s) => reduceEnrollment(s, { type: "redo" })); }, []);

  return (
    <EnrollmentRecorderView state={state} memberName={props.memberName}
      onRecord={() => void onRecord()} onKeep={() => void onKeep()} onRedo={onRedo} onClose={props.onClose} />
  );
}
```

- [ ] **Step 4: Implement `FamilySetup.tsx`**

```tsx
// apps/electron/src/renderer/src/FamilySetup.tsx
import { useEffect, useState } from "react";
import { EnrollmentRecorder } from "./EnrollmentRecorder";

const TARGET = 15;

export function memberRowLabel(member: EnrolledMember, target: number): string {
  return member.sampleCount >= target
    ? `${member.name} — ${member.sampleCount}/${target} ✓`
    : `${member.name} — ${member.sampleCount}/${target}`;
}

export function FamilySetupView(props: {
  members: EnrolledMember[]; target: number;
  onAdd: (name: string) => void; onDelete: (id: string) => void; onEnroll: (id: string) => void; onClose: () => void;
}): JSX.Element {
  return (
    <div className="hub-fullscreen-backdrop family-setup">
      <div className="hub-fullscreen-panel">
        <header className="fullscreen-head"><h2>Family voices</h2><button className="hub-fullscreen-close" onClick={props.onClose}>Close</button></header>
        <ul className="family-list">
          {props.members.map((m) => (
            <li key={m.id}>
              <span>{memberRowLabel(m, props.target)}</span>
              <button onClick={() => props.onEnroll(m.id)}>Record</button>
              <button onClick={() => props.onDelete(m.id)}>Delete</button>
            </li>
          ))}
        </ul>
        <button className="family-add" onClick={() => { const n = window.prompt("Member name"); if (n) props.onAdd(n); }}>Add member</button>
      </div>
    </div>
  );
}

export function FamilySetup(props: { onClose: () => void }): JSX.Element {
  const [members, setMembers] = useState<EnrolledMember[]>([]);
  const [enrolling, setEnrolling] = useState<EnrolledMember | null>(null);
  useEffect(() => {
    void window.familyHub.enrollment.listMembers().then(setMembers);
    return window.familyHub.enrollment.onMembers(setMembers);
  }, []);
  if (enrolling) {
    const live = members.find((m) => m.id === enrolling.id) ?? enrolling;
    return <EnrollmentRecorder memberId={live.id} memberName={live.name} target={TARGET} kept={live.sampleCount} onClose={() => setEnrolling(null)} />;
  }
  return (
    <FamilySetupView members={members} target={TARGET}
      onAdd={(name) => void window.familyHub.enrollment.addMember(name).then(setMembers)}
      onDelete={(id) => void window.familyHub.enrollment.deleteMember(id).then(setMembers)}
      onEnroll={(id) => setEnrolling(members.find((m) => m.id === id) ?? null)}
      onClose={props.onClose} />
  );
}
```

- [ ] **Step 5: Run the View tests + typecheck**

Run: `cd apps/electron && npx vitest run src/renderer/src/EnrollmentRecorder.test.tsx src/renderer/src/FamilySetup.test.tsx && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/renderer/src/EnrollmentRecorder.tsx apps/electron/src/renderer/src/EnrollmentRecorder.test.tsx apps/electron/src/renderer/src/FamilySetup.tsx apps/electron/src/renderer/src/FamilySetup.test.tsx
git commit -m "feat(enrollment): EnrollmentRecorder + FamilySetup views"
```

---

### Task 7: Mount Family Setup in `App.tsx` with pause/resume

**Files:**
- Modify: `apps/electron/src/renderer/src/App.tsx` (entry button + overlay toggle + pause/resume)
- Create: `apps/electron/src/renderer/src/familySetupControl.ts` (pure open/close side-effect plan) + `apps/electron/src/renderer/src/familySetupControl.test.ts`

**Interfaces:**
- Consumes: `FamilySetup` (Task 6), existing `assistant.startListening`/`stopListening`, the existing `captureEpoch` mechanism.
- Produces: pure `familySetupTransition(open: boolean): { listening: "stop" | "start"; bumpCapture: boolean }` so the open/close effects are unit-tested without React.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/electron/src/renderer/src/familySetupControl.test.ts
import { describe, expect, it } from "vitest";
import { familySetupTransition } from "./familySetupControl";

describe("familySetupTransition", () => {
  it("opening stops listening and rebuilds capture", () => {
    expect(familySetupTransition(true)).toEqual({ listening: "stop", bumpCapture: true });
  });
  it("closing resumes listening and rebuilds capture", () => {
    expect(familySetupTransition(false)).toEqual({ listening: "start", bumpCapture: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/electron && npx vitest run src/renderer/src/familySetupControl.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `familySetupControl.ts`**

```typescript
// apps/electron/src/renderer/src/familySetupControl.ts
// Pure plan for the side effects when Family Setup opens/closes: who owns the mic.
// Opening hands the mic to the enrollment recorder (stop wake + tear down capture);
// closing returns it (resume wake + rebuild capture).
export function familySetupTransition(open: boolean): { listening: "stop" | "start"; bumpCapture: boolean } {
  return { listening: open ? "stop" : "start", bumpCapture: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/electron && npx vitest run src/renderer/src/familySetupControl.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `App.tsx` (read it first; reuse `captureEpoch`/listening machinery)**

Add a `const [familySetupOpen, setFamilySetupOpen] = useState(false);` state, an effect that applies `familySetupTransition` on change (calling `assistant.stopListening()`/`startListening()` and bumping `captureEpoch` so the existing capture effect tears down/rebuilds), an entry button near `<MicPicker .../>` (e.g. `<button onClick={() => setFamilySetupOpen(true)}>Family voices</button>`), and `{familySetupOpen && <FamilySetup onClose={() => setFamilySetupOpen(false)} />}` in the render. Example effect:

```tsx
useEffect(() => {
  const plan = familySetupTransition(familySetupOpen);
  if (plan.listening === "stop") void window.familyHub.assistant.stopListening();
  else void window.familyHub.assistant.startListening();
  if (plan.bumpCapture) setCaptureEpoch((e) => e + 1);
}, [familySetupOpen]);
```

(Match the existing `runAction`/effect patterns in `App.tsx`; do not duplicate the capture-build effect — reuse `captureEpoch`.)

- [ ] **Step 6: Full suite + typecheck (regression gate)**

Run: `cd apps/electron && npm run typecheck && npm test`
Expected: typecheck clean; the WHOLE suite (existing `App.test.tsx`, `micLoop.test.ts`, `audioClip.test.ts`, + all new tests) passes. If `App.test.tsx` regresses, fix the wiring — do not weaken the test.

- [ ] **Step 7: Commit**

```bash
git add apps/electron/src/renderer/src/App.tsx apps/electron/src/renderer/src/familySetupControl.ts apps/electron/src/renderer/src/familySetupControl.test.ts
git commit -m "feat(enrollment): mount Family Setup with mic pause/resume"
```

---

## Self-Review

**Spec coverage:** wav (T1), member+clip store (T2), recording-flow reducer (T3), fixed-window capture (T4), IPC/preload/types (T5), recorder+setup views (T6), App mount + pause/resume (T7). All SP1 success-criteria mapped. Voiceprints/embedding/wake-change correctly OUT (→ SP2).

**Placeholder scan:** every code step has complete code or a precise edit spec with example code; the integration steps (T5 ipc.ts, T7 App.tsx) say "read the file first, match the existing pattern" rather than guessing the surrounding lines — a real instruction, not a placeholder, since those files' exact current contents must be matched.

**Type/name consistency:** `EnrolledMember {id,name,sampleCount}` consistent across T2/T5/T6. `EnrollmentState`/`reduceEnrollment`/`isComplete` consistent T3/T6. `recordClip`/`int16ToBase64`/`windowSampleCount`/`accumulateWindow` consistent T4/T6. `enrollment:*` channels + `window.familyHub.enrollment` consistent T5/T6/T7. `familySetupTransition` T7.

**Test idiom:** pure logic + reducers tested directly; React via `renderToStaticMarkup`; no RTL. Matches the repo.

**Cross-task note:** T1–T4 are pure/standalone (fully unit-tested). T5/T7 have a pure helper carrying the test plus a typecheck+suite gate for the thin Electron/React wiring. T6 tests the View markup + pure label/prompt helpers. The container components' live wiring is exercised by typecheck + the regression suite, not by RTL.
