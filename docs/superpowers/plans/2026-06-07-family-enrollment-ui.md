# Family Enrollment UI + Capture — Implementation Plan (Sub-project 1/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-app Family Setup screen to add family members and record ~15 "Hey James" samples each, saved as 16 kHz mono WAV clips per profile — capture + storage + UI only (no voiceprints, no wake/behavior change).

**Architecture:** Reuse the renderer's existing 16 kHz int16 mic pipeline to capture fixed ~2 s clips; send them to main over new IPC; main writes WAV files under `speaker-profiles/<id>/clips/`. Testable logic (WAV encoding, clip store, encode helpers, the recorder flow state machine) lives in pure modules with unit tests; React components are thin wrappers verified by running the app, matching the repo's existing test style.

**Tech Stack:** Electron (main + preload + React renderer), TypeScript, Vitest (pure-function unit tests; NO jsdom/RTL — follow the existing pattern), Node `fs/promises`, Web Audio (`getUserMedia`/`AudioContext`/`ScriptProcessor`).

---

## File Structure

- **Create** `apps/electron/src/main/assistant/wav.ts` — pure `pcm16ToWav(samples, sampleRate): Buffer`.
- **Create** `apps/electron/src/main/assistant/wav.test.ts`.
- **Create** `apps/electron/src/main/assistant/enrollmentStore.ts` — `EnrollmentStore` (saveClip/countClips/deleteLastClip/deleteSpeakerClips).
- **Create** `apps/electron/src/main/assistant/enrollmentStore.test.ts`.
- **Modify** `apps/electron/src/main/assistant/types.ts` — add `EnrolledSpeaker`; `AssistantSnapshot.speakers: EnrolledSpeaker[]`.
- **Modify** `apps/electron/src/main/assistant/service.ts` — hold an `EnrollmentStore`; map `sampleCount` into the snapshot; add `saveEnrollmentClip`; clear clips on `deleteSpeaker`.
- **Modify** `apps/electron/src/main/assistant/service.test.ts` — cover the new method + sampleCount.
- **Modify** `apps/electron/src/main/assistant/ipc.ts` — construct `EnrollmentStore`, register `assistant:saveEnrollmentClip`.
- **Modify** `apps/electron/src/preload/index.ts` — expose `saveEnrollmentClip`.
- **Modify** `apps/electron/src/renderer/src/vite-env.d.ts` — mirror `EnrolledSpeaker`, snapshot type, and the `saveEnrollmentClip` bridge method.
- **Create** `apps/electron/src/renderer/src/audioClip.ts` — `recordClip` (Web Audio) + moved-here pure helpers `int16ToBase64` / `base64ToInt16` / `convertFloatSamplesToLinear16`.
- **Create** `apps/electron/src/renderer/src/audioClip.test.ts` — round-trip the pure encoders.
- **Create** `apps/electron/src/renderer/src/enrollment.ts` — pure flow reducer + `enrollmentStatus` helper.
- **Create** `apps/electron/src/renderer/src/enrollment.test.ts`.
- **Create** `apps/electron/src/renderer/src/EnrollmentRecorder.tsx` — guided recorder (uses `audioClip` + `enrollment` + IPC).
- **Create** `apps/electron/src/renderer/src/FamilySetup.tsx` — overlay: list + add/delete/allow + open recorder.
- **Modify** `apps/electron/src/renderer/src/App.tsx` — Setup button, `showSetup` state, pause/resume wake, render overlay; import moved encoders from `audioClip.ts`.

Note: the design's `deleteEnrollmentClip` (saved-clip deletion) is dropped — the
recorder's review step (play → keep/redo) discards a bad take **before** it is
saved, so no saved-clip deletion IPC is needed in this sub-project (YAGNI).
`EnrollmentStore` keeps `deleteSpeakerClips` (used by `deleteSpeaker`).

---

## Task 1: `wav.ts` — pure PCM16→WAV encoder

**Files:**
- Create: `apps/electron/src/main/assistant/wav.ts`
- Test: `apps/electron/src/main/assistant/wav.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/electron/src/main/assistant/wav.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pcm16ToWav } from "./wav";

describe("pcm16ToWav", () => {
  const samples = new Int16Array([0, 1, -1, 32767, -32768]);
  const wav = pcm16ToWav(samples, 16000);

  it("has a RIFF/WAVE/fmt/data header", () => {
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
  });

  it("declares mono 16-bit PCM at the given sample rate", () => {
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits/sample
  });

  it("sizes the buffer and data chunk to the samples", () => {
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2);
    expect(wav.readUInt32LE(4)).toBe(36 + samples.length * 2);
  });

  it("writes the samples as little-endian int16", () => {
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(46)).toBe(1);
    expect(wav.readInt16LE(48)).toBe(-1);
    expect(wav.readInt16LE(50)).toBe(32767);
    expect(wav.readInt16LE(52)).toBe(-32768);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/main/assistant/wav.test.ts`
Expected: FAIL — cannot find module `./wav`.

- [ ] **Step 3: Write the implementation**

Create `apps/electron/src/main/assistant/wav.ts`:

```ts
// Minimal canonical PCM WAV (mono, 16-bit) encoder for enrollment clips.
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate = rate * blockAlign
  buffer.writeUInt16LE(2, 32); // block align = channels * bytesPerSample
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run src/main/assistant/wav.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/assistant/wav.ts apps/electron/src/main/assistant/wav.test.ts
git commit -m "feat(enroll): pure PCM16->WAV encoder for enrollment clips"
```

---

## Task 2: `enrollmentStore.ts` — clip persistence

**Files:**
- Create: `apps/electron/src/main/assistant/enrollmentStore.ts`
- Test: `apps/electron/src/main/assistant/enrollmentStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/electron/src/main/assistant/enrollmentStore.test.ts`:

```ts
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnrollmentStore } from "./enrollmentStore";

describe("EnrollmentStore", () => {
  let dir: string;
  let store: EnrollmentStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fh-enroll-"));
    store = new EnrollmentStore(dir);
  });

  const pcm = () => new Int16Array([1, 2, 3, 4]);

  it("starts at zero clips for an unknown speaker", async () => {
    expect(await store.countClips("spk-1")).toBe(0);
  });

  it("saves clips with incrementing zero-padded names and counts them", async () => {
    expect(await store.saveClip("spk-1", pcm())).toBe(1);
    expect(await store.saveClip("spk-1", pcm())).toBe(2);
    const files = (
      await readdir(join(dir, "speaker-profiles", "spk-1", "clips"))
    ).sort();
    expect(files).toEqual(["clip_0000.wav", "clip_0001.wav"]);
    expect(await store.countClips("spk-1")).toBe(2);
  });

  it("removes all of a speaker's clips", async () => {
    await store.saveClip("spk-1", pcm());
    await store.deleteSpeakerClips("spk-1");
    expect(await store.countClips("spk-1")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/main/assistant/enrollmentStore.test.ts`
Expected: FAIL — cannot find module `./enrollmentStore`.

- [ ] **Step 3: Write the implementation**

Create `apps/electron/src/main/assistant/enrollmentStore.ts`:

```ts
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pcm16ToWav } from "./wav";

const SAMPLE_RATE = 16000;
const CLIP_RE = /^clip_\d{4}\.wav$/;

// Persists per-speaker enrollment clips under
// <userData>/speaker-profiles/<id>/clips/clip_NNNN.wav.
export class EnrollmentStore {
  private readonly root: string;

  constructor(userDataDirectory: string) {
    this.root = join(userDataDirectory, "speaker-profiles");
  }

  private clipsDir(speakerId: string): string {
    return join(this.root, speakerId, "clips");
  }

  private async clipFiles(speakerId: string): Promise<string[]> {
    try {
      const files = await readdir(this.clipsDir(speakerId));
      return files.filter((f) => CLIP_RE.test(f)).sort();
    } catch {
      return [];
    }
  }

  async countClips(speakerId: string): Promise<number> {
    return (await this.clipFiles(speakerId)).length;
  }

  async saveClip(speakerId: string, samples: Int16Array): Promise<number> {
    const dir = this.clipsDir(speakerId);
    await mkdir(dir, { recursive: true });
    const index = (await this.clipFiles(speakerId)).length;
    const name = `clip_${String(index).padStart(4, "0")}.wav`;
    await writeFile(join(dir, name), pcm16ToWav(samples, SAMPLE_RATE));
    return index + 1;
  }

  async deleteSpeakerClips(speakerId: string): Promise<void> {
    await rm(join(this.root, speakerId), { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run src/main/assistant/enrollmentStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/assistant/enrollmentStore.ts apps/electron/src/main/assistant/enrollmentStore.test.ts
git commit -m "feat(enroll): EnrollmentStore persists per-speaker WAV clips"
```

---

## Task 3: `EnrolledSpeaker` type + service wiring

**Files:**
- Modify: `apps/electron/src/main/assistant/types.ts`
- Modify: `apps/electron/src/main/assistant/service.ts`
- Test: `apps/electron/src/main/assistant/service.test.ts`

- [ ] **Step 1: Add the `EnrolledSpeaker` type**

In `apps/electron/src/main/assistant/types.ts`, immediately after the
`SpeakerProfileSummary` interface (ends at line 6) add:

```ts
export interface EnrolledSpeaker extends SpeakerProfileSummary {
  sampleCount: number;
}
```

And change the `speakers` field of `AssistantSnapshot` (currently
`speakers: SpeakerProfileSummary[];`) to:

```ts
  speakers: EnrolledSpeaker[];
```

- [ ] **Step 2: Write the failing test**

In `apps/electron/src/main/assistant/service.test.ts`, add this block inside the
top-level `describe` (create a fresh temp dir per test; reuse the existing
`AssistantService` construction style already in that file — it currently
constructs with `{ gemini, profileStore }`, so you will thread in
`enrollmentStore` too):

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnrollmentStore } from "./enrollmentStore";
import { FileSpeakerProfileStore } from "./profileStore";

describe("enrollment clips", () => {
  it("saves a clip and reports sampleCount in the snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-svc-"));
    const service = new AssistantService({
      gemini: new PlaceholderGeminiLive(),
      profileStore: new FileSpeakerProfileStore(dir),
      enrollmentStore: new EnrollmentStore(dir),
    });
    const speaker = await service.enrollSpeaker("Mom");

    // 2 int16 samples => base64 of 4 bytes
    const b64 = Buffer.from(new Int16Array([7, -7]).buffer).toString("base64");
    expect(await service.saveEnrollmentClip(speaker.id, b64)).toEqual({
      sampleCount: 1,
    });

    const snap = await service.getSnapshot();
    const mom = snap.speakers.find((s) => s.id === speaker.id);
    expect(mom?.sampleCount).toBe(1);
  });

  it("removes clips when the speaker is deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-svc-"));
    const enrollmentStore = new EnrollmentStore(dir);
    const service = new AssistantService({
      gemini: new PlaceholderGeminiLive(),
      profileStore: new FileSpeakerProfileStore(dir),
      enrollmentStore,
    });
    const speaker = await service.enrollSpeaker("Kid");
    const b64 = Buffer.from(new Int16Array([1]).buffer).toString("base64");
    await service.saveEnrollmentClip(speaker.id, b64);

    await service.deleteSpeaker(speaker.id);
    expect(await enrollmentStore.countClips(speaker.id)).toBe(0);
  });
});
```

(If `PlaceholderGeminiLive` is not already imported in the test file, add it to
the existing import from `./service`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/main/assistant/service.test.ts`
Expected: FAIL — `enrollmentStore` not accepted in options / `saveEnrollmentClip` not a function.

- [ ] **Step 4: Wire the service**

In `apps/electron/src/main/assistant/service.ts`:

1. Add the import near the other store import:

```ts
import { EnrollmentStore } from "./enrollmentStore";
```

2. Add `EnrolledSpeaker` to the existing type import from `./types` (it already
   imports `SpeakerProfileSummary` etc.).

3. In `AssistantServiceOptions` (the options interface in this file) add:

```ts
  enrollmentStore: EnrollmentStore;
```

4. Add the field + assign it in the constructor (alongside `profileStore`):

```ts
  private readonly enrollmentStore: EnrollmentStore;
```
```ts
    this.enrollmentStore = enrollmentStore; // in the constructor body
```
and update the constructor destructuring to `{ gemini, profileStore, enrollmentStore }`.

5. Replace the snapshot's `speakers: await this.profileStore.list(),` line with:

```ts
      speakers: await this.listEnrolledSpeakers(),
```

6. Add these methods to the class (e.g. just below `deleteSpeaker`):

```ts
  private async listEnrolledSpeakers(): Promise<EnrolledSpeaker[]> {
    const speakers = await this.profileStore.list();
    return Promise.all(
      speakers.map(async (speaker) => ({
        ...speaker,
        sampleCount: await this.enrollmentStore.countClips(speaker.id),
      })),
    );
  }

  async saveEnrollmentClip(
    speakerId: string,
    audioBase64: string,
  ): Promise<{ sampleCount: number }> {
    const bytes = Buffer.from(audioBase64, "base64");
    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 2),
    );
    const sampleCount = await this.enrollmentStore.saveClip(speakerId, samples);
    return { sampleCount };
  }

```

7. In `deleteSpeaker`, after `const deleted = await this.profileStore.delete(speakerId);`
   add (inside the `if (deleted)` block):

```ts
      await this.enrollmentStore.deleteSpeakerClips(speakerId);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run src/main/assistant/service.test.ts`
Expected: PASS (existing + 2 new tests).

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/assistant/types.ts apps/electron/src/main/assistant/service.ts apps/electron/src/main/assistant/service.test.ts
git commit -m "feat(enroll): service saves/counts enrollment clips, sampleCount in snapshot"
```

---

## Task 4: IPC handlers + preload bridge + renderer types

**Files:**
- Modify: `apps/electron/src/main/assistant/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/src/vite-env.d.ts`

- [ ] **Step 1: Construct the store and pass it to the service (ipc.ts)**

In `apps/electron/src/main/assistant/ipc.ts`, add the import next to the
`FileSpeakerProfileStore` import:

```ts
import { EnrollmentStore } from "./enrollmentStore";
```

Change the `new AssistantService({ ... })` construction to include the store:

```ts
  const service = new AssistantService({
    gemini,
    profileStore: new FileSpeakerProfileStore(userDataDirectory),
    enrollmentStore: new EnrollmentStore(userDataDirectory),
  });
```

- [ ] **Step 2: Register the two handlers (ipc.ts)**

Immediately after the existing `assistant:deleteSpeaker` handler (ends ~line 202)
add:

```ts
  ipcMain.handle(
    "assistant:saveEnrollmentClip",
    async (event, speakerId: unknown, audioBase64: unknown) => {
      const result = await service.saveEnrollmentClip(
        requireString(speakerId, "Speaker id"),
        requireString(audioBase64, "Audio"),
      );
      await emitSnapshot(event.sender, service);
      return result;
    },
  );
```

- [ ] **Step 3: Expose them on the preload bridge**

In `apps/electron/src/preload/index.ts`, inside the `assistant:` object (e.g.
after `enrollSpeaker`), add:

```ts
    saveEnrollmentClip: (speakerId: string, audioBase64: string) =>
      ipcRenderer.invoke(
        "assistant:saveEnrollmentClip",
        speakerId,
        audioBase64,
      ) as Promise<{ sampleCount: number }>,
```

- [ ] **Step 4: Declare the new types/methods in the renderer (vite-env.d.ts)**

In `apps/electron/src/renderer/src/vite-env.d.ts`:

1. After the `SpeakerProfileSummary` interface add:

```ts
interface EnrolledSpeaker extends SpeakerProfileSummary {
  sampleCount: number;
}
```

2. Change `AssistantSnapshot`'s `speakers: SpeakerProfileSummary[];` to
   `speakers: EnrolledSpeaker[];`.

3. In `interface AssistantBridge`, add:

```ts
  saveEnrollmentClip: (
    speakerId: string,
    audioBase64: string,
  ) => Promise<{ sampleCount: number }>;
```

- [ ] **Step 5: Verify typecheck + existing tests**

Run: `cd apps/electron && npm run typecheck && npx vitest run src/main/assistant`
Expected: typecheck clean; assistant suite passes.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/assistant/ipc.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/src/vite-env.d.ts
git commit -m "feat(enroll): IPC + preload bridge for saving/discarding enrollment clips"
```

---

## Task 5: `audioClip.ts` — recorder + pure encoders (DRY move)

**Files:**
- Create: `apps/electron/src/renderer/src/audioClip.ts`
- Create: `apps/electron/src/renderer/src/audioClip.test.ts`
- Modify: `apps/electron/src/renderer/src/App.tsx` (import the moved helpers)

- [ ] **Step 1: Write the failing test**

Create `apps/electron/src/renderer/src/audioClip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { base64ToInt16, int16ToBase64 } from "./audioClip";

describe("int16/base64 round-trip", () => {
  it("encodes and decodes int16 samples losslessly", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 12345]);
    const decoded = base64ToInt16(int16ToBase64(samples));
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  it("produces empty base64 for empty input", () => {
    expect(int16ToBase64(new Int16Array())).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/renderer/src/audioClip.test.ts`
Expected: FAIL — cannot find module `./audioClip`.

- [ ] **Step 3: Create `audioClip.ts` (move the existing helpers + add `recordClip`)**

Create `apps/electron/src/renderer/src/audioClip.ts`. The first three functions
are MOVED verbatim from `App.tsx` (currently `base64ToInt16` ~589-602,
`int16ToBase64` ~604-619, `convertFloatSamplesToLinear16` ~621-631):

```ts
export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 2),
  );
}

export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function convertFloatSamplesToLinear16(samples: number[]): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (const [index, sample] of samples.entries()) {
    const clampedSample = Math.max(-1, Math.min(1, sample));
    pcm[index] = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff;
  }
  return pcm;
}

// Play an int16 PCM clip once via a transient AudioContext (enrollment review).
export function playClip(samples: Int16Array, sampleRate = 16000): void {
  const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
  const audioContext = new AudioContextConstructor();
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = () => void audioContext.close();
  source.start();
}

// Capture a fixed window of 16 kHz mono int16 from the mic. Mirrors the wake
// capture setup but buffers a clip instead of streaming frames. Owns and frees
// its own AudioContext + stream.
export async function recordClip(
  durationMs = 2000,
  sampleRate = 16000,
): Promise<Int16Array> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone is not available.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
  const audioContext = new AudioContextConstructor({ sampleRate });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mutedOutput = audioContext.createGain();
  mutedOutput.gain.value = 0;

  const samples: number[] = [];
  const target = Math.floor((durationMs / 1000) * sampleRate);

  return new Promise<Int16Array>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      processor.disconnect();
      source.disconnect();
      mutedOutput.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void audioContext.close();
      resolve(convertFloatSamplesToLinear16(samples.slice(0, target)));
    };
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i += 1) samples.push(input[i]);
      if (samples.length >= target) finish();
    };
    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(audioContext.destination);
    // Safety stop in case onaudioprocess starves.
    setTimeout(() => {
      if (samples.length === 0) {
        for (const track of stream.getTracks()) track.stop();
        void audioContext.close();
        reject(new Error("No audio captured."));
      } else {
        finish();
      }
    }, durationMs + 1500);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run src/renderer/src/audioClip.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Point `App.tsx` at the moved helpers (DRY)**

In `apps/electron/src/renderer/src/App.tsx`, DELETE the local definitions of
`base64ToInt16`, `int16ToBase64`, and `convertFloatSamplesToLinear16`, and add an
import near the top:

```ts
import { base64ToInt16, convertFloatSamplesToLinear16, int16ToBase64 } from "./audioClip";
```

(Keep `calculateMicrophoneLevel` in `App.tsx` — `App.test.tsx` imports it from there.)

- [ ] **Step 6: Verify the existing suite + typecheck still pass**

Run: `cd apps/electron && npm run typecheck && npx vitest run src/renderer`
Expected: PASS (App.test.tsx + audioClip.test.ts green; no duplicate-symbol errors).

- [ ] **Step 7: Commit**

```bash
git add apps/electron/src/renderer/src/audioClip.ts apps/electron/src/renderer/src/audioClip.test.ts apps/electron/src/renderer/src/App.tsx
git commit -m "refactor(enroll): extract audio encoders to audioClip.ts; add recordClip"
```

---

## Task 6: `enrollment.ts` — pure recorder flow

**Files:**
- Create: `apps/electron/src/renderer/src/enrollment.ts`
- Test: `apps/electron/src/renderer/src/enrollment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/electron/src/renderer/src/enrollment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { enrollmentStatus, ENROLLMENT_TARGET } from "./enrollment";

describe("enrollmentStatus", () => {
  it("is 'none' with no samples", () => {
    expect(enrollmentStatus(0)).toBe("none");
  });
  it("is 'under' below the target", () => {
    expect(enrollmentStatus(ENROLLMENT_TARGET - 1)).toBe("under");
  });
  it("is 'complete' at or above the target", () => {
    expect(enrollmentStatus(ENROLLMENT_TARGET)).toBe("complete");
    expect(enrollmentStatus(ENROLLMENT_TARGET + 5)).toBe("complete");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/electron && npx vitest run src/renderer/src/enrollment.test.ts`
Expected: FAIL — cannot find module `./enrollment`.

- [ ] **Step 3: Write the implementation**

Create `apps/electron/src/renderer/src/enrollment.ts`:

```ts
export const ENROLLMENT_TARGET = 15;

export type EnrollmentStatus = "none" | "under" | "complete";

export function enrollmentStatus(
  sampleCount: number,
  target: number = ENROLLMENT_TARGET,
): EnrollmentStatus {
  if (sampleCount <= 0) return "none";
  if (sampleCount < target) return "under";
  return "complete";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/electron && npx vitest run src/renderer/src/enrollment.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/renderer/src/enrollment.ts apps/electron/src/renderer/src/enrollment.test.ts
git commit -m "feat(enroll): enrollment target + status helper"
```

---

## Task 7: `EnrollmentRecorder.tsx` + `FamilySetup.tsx` (components)

These are thin React components (no unit tests — matching the repo's pure-only
test style); they are verified by running the app in Task 9.

**Files:**
- Create: `apps/electron/src/renderer/src/EnrollmentRecorder.tsx`
- Create: `apps/electron/src/renderer/src/FamilySetup.tsx`

- [ ] **Step 1: Create `EnrollmentRecorder.tsx`**

```tsx
import { useState } from "react";
import { int16ToBase64, playClip, recordClip } from "./audioClip";
import { ENROLLMENT_TARGET } from "./enrollment";

interface EnrollmentRecorderProps {
  speakerId: string;
  speakerName: string;
  sampleCount: number;
  onClose: () => void;
}

type Phase = "idle" | "recording" | "review" | "saving" | "error";

export function EnrollmentRecorder({
  speakerId,
  speakerName,
  sampleCount,
  onClose,
}: EnrollmentRecorderProps): React.JSX.Element {
  const [count, setCount] = useState(sampleCount);
  const [phase, setPhase] = useState<Phase>("idle");
  const [clip, setClip] = useState<Int16Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  const record = async () => {
    setPhase("recording");
    setError(null);
    try {
      const pcm = await recordClip();
      setClip(pcm);
      setPhase("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recording failed.");
      setPhase("error");
    }
  };

  const keep = async () => {
    if (!clip) return;
    setPhase("saving");
    try {
      const { sampleCount: next } =
        await window.familyHub.assistant.saveEnrollmentClip(
          speakerId,
          int16ToBase64(clip),
        );
      setCount(next);
      setClip(null);
      setPhase("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saving failed.");
      setPhase("error");
    }
  };

  // Redo discards the in-memory take before it is ever saved (no disk delete).
  const redo = () => {
    setClip(null);
    setPhase("idle");
  };

  return (
    <div className="enroll-recorder">
      <h3>
        Enroll {speakerName} — sample {Math.min(count + 1, ENROLLMENT_TARGET)} /{" "}
        {ENROLLMENT_TARGET}
      </h3>
      <p className="enroll-prompt">
        Say: <strong>Hey James</strong>
      </p>
      <div className="enroll-status">
        {phase === "recording" && <span>● recording…</span>}
        {phase === "saving" && <span>saving…</span>}
        {phase === "error" && <span className="enroll-error">{error}</span>}
        {(phase === "idle" || phase === "review") && <span>{count} saved</span>}
      </div>

      {phase === "review" && clip ? (
        <div className="enroll-actions">
          <button type="button" onClick={() => playClip(clip)}>
            ▶ Play
          </button>
          <button type="button" onClick={redo}>
            ↻ Redo
          </button>
          <button type="button" onClick={keep}>
            ✓ Keep
          </button>
        </div>
      ) : (
        <div className="enroll-actions">
          <button
            type="button"
            onClick={record}
            disabled={phase === "recording" || phase === "saving"}
          >
            {count >= ENROLLMENT_TARGET ? "Record more" : "Record"}
          </button>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `FamilySetup.tsx`**

```tsx
import { useState } from "react";
import { EnrollmentRecorder } from "./EnrollmentRecorder";
import { enrollmentStatus } from "./enrollment";

interface FamilySetupProps {
  speakers: EnrolledSpeaker[];
  onClose: () => void;
}

export function FamilySetup({ speakers, onClose }: FamilySetupProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [active, setActive] = useState<EnrolledSpeaker | null>(null);

  const addPerson = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await window.familyHub.assistant.enrollSpeaker(trimmed);
    setName("");
  };

  if (active) {
    const latest = speakers.find((s) => s.id === active.id) ?? active;
    return (
      <div className="family-setup">
        <EnrollmentRecorder
          speakerId={latest.id}
          speakerName={latest.name}
          sampleCount={latest.sampleCount}
          onClose={() => setActive(null)}
        />
      </div>
    );
  }

  return (
    <div className="family-setup">
      <header className="family-setup-header">
        <h2>Family</h2>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </header>

      <div className="family-add">
        <input
          value={name}
          placeholder="Add family member"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" onClick={addPerson} disabled={!name.trim()}>
          + Add
        </button>
      </div>

      <ul className="family-list">
        {speakers.map((speaker) => (
          <li key={speaker.id} className="family-row">
            <span className="family-name">{speaker.name}</span>
            <span className={`family-count ${enrollmentStatus(speaker.sampleCount)}`}>
              {speaker.sampleCount} samples
            </span>
            <button type="button" onClick={() => setActive(speaker)}>
              {speaker.sampleCount > 0 ? "Re-record" : "Enroll"}
            </button>
            <label>
              <input
                type="checkbox"
                checked={speaker.allowed}
                onChange={(event) =>
                  window.familyHub.assistant.setSpeakerAllowed(
                    speaker.id,
                    event.target.checked,
                  )
                }
              />
              allowed
            </label>
            <button
              type="button"
              onClick={() => window.familyHub.assistant.deleteSpeaker(speaker.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/electron && npm run typecheck`
Expected: clean (components compile; `window.familyHub` + `EnrolledSpeaker` resolve from `vite-env.d.ts`).

- [ ] **Step 4: Commit**

```bash
git add apps/electron/src/renderer/src/EnrollmentRecorder.tsx apps/electron/src/renderer/src/FamilySetup.tsx
git commit -m "feat(enroll): Family Setup overlay + guided enrollment recorder UI"
```

---

## Task 8: Wire into `App.tsx` (button, overlay, pause/resume)

**Files:**
- Modify: `apps/electron/src/renderer/src/App.tsx`

- [ ] **Step 1: Import and add state**

`useState`/`useEffect` are already imported (line 1). Add the component import
after the other panel imports (after line 4):

```ts
import { FamilySetup } from "./FamilySetup";
```

The snapshot lives in `const [snapshot, setSnapshot] = useState<AssistantSnapshot>(emptySnapshot)`
(line 32). Add the overlay-visibility state next to the other `useState` hooks
(e.g. after line 32):

```ts
  const [showSetup, setShowSetup] = useState(false);
```

- [ ] **Step 2: Pause wake while setup is open, resume on close**

Add an effect in the `App` component (the renderer already calls
`window.familyHub.assistant.startListening()` / `stopListening()`):

```ts
  useEffect(() => {
    if (showSetup) {
      void window.familyHub.assistant.stopListening();
      return () => {
        void window.familyHub.assistant.startListening();
      };
    }
    return undefined;
  }, [showSetup]);
```

- [ ] **Step 3: Add the Setup button + render the overlay**

In the component's returned JSX, add a Setup button in the voice strip / header
area (follow the existing button markup in that region):

```tsx
        <button
          type="button"
          className="setup-button"
          onClick={() => setShowSetup(true)}
          aria-label="Family setup"
        >
          ⚙
        </button>
```

And render the overlay at the end of the top-level returned element (`snapshot`
is the state variable from line 32):

```tsx
        {showSetup && (
          <div className="setup-overlay">
            <FamilySetup
              speakers={snapshot.speakers}
              onClose={() => setShowSetup(false)}
            />
          </div>
        )}
```

- [ ] **Step 4: Add minimal overlay styling**

In `apps/electron/src/renderer/src/styles.css`, append:

```css
.setup-overlay {
  position: fixed;
  inset: 0;
  background: rgba(8, 12, 20, 0.96);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.family-setup {
  width: min(92vw, 520px);
  color: #f4f6fb;
  font-size: 1.1rem;
}
.family-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.family-name { flex: 1; }
.family-count.none { color: #ff8a8a; }
.family-count.under { color: #ffd27a; }
.family-count.complete { color: #8ae6a1; }
.enroll-prompt { font-size: 1.6rem; }
.enroll-error { color: #ff8a8a; }
.setup-button { background: none; border: none; font-size: 1.3rem; cursor: pointer; }
```

- [ ] **Step 5: Typecheck + full test suite**

Run: `cd apps/electron && npm run typecheck && npm test`
Expected: typecheck clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/renderer/src/App.tsx apps/electron/src/renderer/src/styles.css
git commit -m "feat(enroll): Family Setup button + overlay wired into the dashboard"
```

---

## Task 9: Regression + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Full automated gates**

Run: `cd apps/electron && npm run typecheck && npm run lint && npm test`
Expected: all clean/green. The new pure tests (`wav`, `enrollmentStore`, `service`
enrollment block, `audioClip`, `enrollment`) pass; existing suites unaffected.

- [ ] **Step 2: Manual smoke (run the app)**

Build + launch per the project runbook (`npm run package`, launch
`release/mac-arm64/FamilyHub.app`). Then:
1. Tap the ⚙ Setup button → Family overlay opens; wake listening pauses.
2. Add "Test" → appears with "0 samples" (red).
3. Enroll → press Record, say "Hey James"; counter increments; "Redo last"
   decrements. Record a few.
4. Confirm clips exist on disk: `ls "$HOME/Library/Application Support/<app>/speaker-profiles/"<id>"/clips"` shows `clip_0000.wav …` and the files play (`afplay`).
5. Toggle allowed, Delete the person → its `speaker-profiles/<id>` folder is removed.
6. Close setup (Done) → wake listening resumes (say "Hey James" still works).

Report results; if any step fails, fix before declaring complete.

---

## Notes for the implementer

- **No jsdom/RTL.** Renderer tests are pure-function only (see `App.test.tsx`).
  Components are verified by running the app (Task 9), not by rendering in tests.
- **Scope discipline:** the working tree has unrelated WIP and a parallel
  speaker-lock effort. Every `git add` names exact files — never `git add -A`.
- **No voiceprints / no gate changes here.** This sub-project only captures and
  stores clips and shows counts. Sub-projects 2 (voiceprints + unified gate) and
  3 (wake retrain from these clips) build on it.
- The clips written here (`speaker-profiles/<id>/clips/clip_NNNN.wav`, 16 kHz mono
  PCM16) are already in the exact format sub-projects 2 and 3 consume.
