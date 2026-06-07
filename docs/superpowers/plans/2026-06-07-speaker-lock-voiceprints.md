# Speaker-Lock via Family Voiceprints — Implementation Plan (Sub-project 2/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only an enrolled family member's voice reaches Gemini — compute persistent titanet voiceprints from the SP1 clips, and make the live gate hard-lock to whoever woke James (ending the session immediately if no enrolled voice matches).

**Architecture:** A shared `speaker_embed.py` (titanet embed + voiceprint averaging) feeds both a one-shot voiceprint computer (spawned by `VoiceprintStore` on enrollment) and the live `speaker_gate.py`, which is upgraded from "first speaker wins" to "match the wake utterance against the loaded family voiceprints → lock to that live voice, or reject". The controller loads the allowed family's voiceprints at session start and ends the session on a `rejected` decision.

**Tech Stack:** Python 3.11 (`sherpa-onnx`, `numpy`), TypeScript (Electron main + preload + React), Vitest (pure-function tests; no jsdom), stdio JSON protocol.

---

## File Structure

- **Create** `sidecar/speaker_embed.py` — `average_normalize`, `embed`, `mean_voiceprint`, CLI one-shot.
- **Create** `sidecar/test_speakerlock.py` — pure tests for `average_normalize` (in speaker_embed) + `decide` (in speaker_gate).
- **Modify** `sidecar/speaker_gate.py` — import `speaker_embed`; add pure `decide()`; add `{"cmd":"load"}`; replace first-speaker flow with family-match/hard-lock/reject.
- **Create** `apps/electron/src/main/assistant/voiceprintStore.ts` — compute (spawn) / load / loadAll / has / delete.
- **Create** `apps/electron/src/main/assistant/voiceprintStore.test.ts`.
- **Modify** `apps/electron/src/main/assistant/types.ts` — `EnrolledSpeaker.hasVoiceprint`.
- **Modify** `apps/electron/src/main/assistant/service.ts` — hold a `VoiceprintStore`; `finalizeEnrollment`; `hasVoiceprint` in snapshot; voiceprint cleanup on `deleteSpeaker`.
- **Modify** `apps/electron/src/main/assistant/service.test.ts` — cover `finalizeEnrollment` + `hasVoiceprint`.
- **Modify** `apps/electron/src/main/assistant/ipc.ts` — construct `VoiceprintStore`; register `assistant:finalizeEnrollment`; pass `getVoiceprints` to the controller.
- **Modify** `apps/electron/src/preload/index.ts` + `renderer/src/vite-env.d.ts` — `finalizeEnrollment` bridge + `EnrolledSpeaker.hasVoiceprint`.
- **Modify** `apps/electron/src/renderer/src/EnrollmentRecorder.tsx` — call `finalizeEnrollment` on "Done".
- **Modify** `apps/electron/src/main/assistant/speakerGate.ts` — `loadVoiceprints()`; `"rejected"` decision.
- **Modify** `apps/electron/src/main/assistant/liveController.ts` — `getVoiceprints` option; `loadVoiceprints` at session start; end session on `rejected`.

---

## Task 1: `speaker_embed.py` — shared titanet embed + voiceprint

**Files:** Create `sidecar/speaker_embed.py`, `sidecar/test_speakerlock.py`.

- [ ] **Step 1: Write the failing test** — `sidecar/test_speakerlock.py`:

```python
#!/usr/bin/env python3
"""Pure tests for speaker-lock math. Run: sidecar/.venv/bin/python sidecar/test_speakerlock.py"""
import sys
import numpy as np
from speaker_embed import average_normalize

def almost(a, b):
    return float(np.linalg.norm(np.asarray(a) - np.asarray(b))) < 1e-5

CASES_OK = []

def check(name, cond):
    CASES_OK.append((name, cond))
    print(f"  {'ok' if cond else 'FAIL'}  {name}")

# average of two identical unit vectors is the same unit vector
v = np.array([0.6, 0.8], dtype=np.float32)
check("identical -> same unit vector", almost(average_normalize([v, v]), v))
# result is always unit-norm
out = average_normalize([np.array([1.0, 0.0]), np.array([0.0, 1.0])])
check("output is unit norm", abs(float(np.linalg.norm(out)) - 1.0) < 1e-5)
check("output is the 45-degree unit vector", almost(out, [0.70710678, 0.70710678]))

if __name__ == "__main__":
    ok = all(c for _, c in CASES_OK)
    print("\nPASS" if ok else "\nFAIL")
    sys.exit(0 if ok else 1)
```

Run: `sidecar/.venv/bin/python sidecar/test_speakerlock.py` → FAIL (no module `speaker_embed`).

- [ ] **Step 2: Implement** — `sidecar/speaker_embed.py`:

```python
#!/usr/bin/env python3
"""Shared titanet speaker-embedding helpers + a one-shot voiceprint computer.

CLI: python speaker_embed.py <clips_dir>
  reads clip_*.wav, prints the mean L2-normalized voiceprint as a JSON float
  array on stdout. Exit non-zero on error.
"""
import glob
import json
import os
import sys
import wave

import numpy as np

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_EMBEDDER = os.path.join(HERE, "models", "nemo_en_titanet_small.onnx")


def average_normalize(vectors):
    """Mean of the given vectors, re-normalized to unit length (pure)."""
    stacked = np.stack([np.asarray(v, dtype=np.float32) for v in vectors])
    mean = stacked.mean(axis=0)
    norm = float(np.linalg.norm(mean))
    return (mean / norm) if norm > 0 else mean


def load_extractor(model_path=DEFAULT_EMBEDDER):
    import sherpa_onnx as so

    return so.SpeakerEmbeddingExtractor(
        so.SpeakerEmbeddingExtractorConfig(
            model=model_path, num_threads=1, provider="cpu"
        )
    )


def embed(extractor, samples):
    """L2-normalized titanet embedding of float32 mono @16k samples."""
    stream = extractor.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    stream.input_finished()
    vec = np.array(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 0 else vec


def _read_wav(path):
    with wave.open(path, "rb") as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def mean_voiceprint(extractor, clip_paths):
    vectors = [embed(extractor, _read_wav(p)) for p in clip_paths]
    return average_normalize(vectors)


def main():
    clips_dir = sys.argv[1]
    paths = sorted(glob.glob(os.path.join(clips_dir, "clip_*.wav")))
    if not paths:
        print(f"no clips in {clips_dir}", file=sys.stderr)
        return 1
    extractor = load_extractor()
    vec = mean_voiceprint(extractor, paths)
    sys.stdout.write(json.dumps([float(x) for x in vec]))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run the test → PASS (3 checks).

- [ ] **Step 3: Commit**

```bash
git add sidecar/speaker_embed.py sidecar/test_speakerlock.py
git commit -m "feat(speaker): shared titanet embed + mean voiceprint helper"
```

---

## Task 2: `decide()` — pure gate verdict

**Files:** Modify `sidecar/speaker_gate.py`, `sidecar/test_speakerlock.py`.

- [ ] **Step 1: Add the failing test** — append to `sidecar/test_speakerlock.py` (before the `if __name__` block):

```python
from speaker_gate import decide  # noqa: E402

u = lambda *xs: np.array(xs, dtype=np.float32)  # noqa: E731
A = u(1.0, 0.0)
B = u(0.0, 1.0)
NEARA = u(0.96, 0.28)  # cosine ~0.96 with A

check("locked + match -> forward", decide([], A, NEARA, 0.6)[0] == "forward")
check("locked + mismatch -> drop", decide([], A, B, 0.6)[0] == "drop")
check("no refs -> open-mic lock", decide([], None, B, 0.6)[0] == "lock")
check("family match -> lock to id", decide([("mom", A)], None, NEARA, 0.6) == ("lock", "mom"))
check("no family match -> rejected", decide([("mom", A)], None, B, 0.6)[0] == "rejected")
```

Run: `sidecar/.venv/bin/python sidecar/test_speakerlock.py` → FAIL (no `decide`).

- [ ] **Step 2: Implement `decide` in `sidecar/speaker_gate.py`** — add near the top (after imports, before `main`):

```python
def decide(refs, locked, emb, threshold):
    """Pure gate verdict.

    refs: list of (speaker_id, voiceprint np.ndarray) — the loaded family.
    locked: the locked reference embedding (np.ndarray) or None.
    emb: the current utterance embedding (np.ndarray).
    Returns one of:
      ("forward", None)   — matches the locked wake voice
      ("drop", None)      — a different voice during a locked session
      ("lock", speaker_id)— first utterance matches family (or open-mic when no
                            refs, speaker_id None) → caller locks to `emb`
      ("rejected", best)  — first utterance matched no enrolled family
    """
    if locked is not None:
        score = float(np.dot(locked, emb))
        return ("forward", None) if score >= threshold else ("drop", None)
    if not refs:
        return ("lock", None)  # open-mic fallback: nobody enrolled yet
    best_id, best = None, -1.0
    for speaker_id, vec in refs:
        score = float(np.dot(vec, emb))
        if score > best:
            best, best_id = score, speaker_id
    return ("lock", best_id) if best >= threshold else ("rejected", best)
```

Run the test → PASS (8 checks total).

- [ ] **Step 3: Commit**

```bash
git add sidecar/speaker_gate.py sidecar/test_speakerlock.py
git commit -m "feat(speaker): pure decide() gate verdict (lock/forward/drop/reject)"
```

---

## Task 3: Wire `speaker_gate.py` to family voiceprints

**Files:** Modify `sidecar/speaker_gate.py`.

Replaces the "first speaker wins" body with: load family voiceprints via a control
message, and route each VAD segment through `decide()`.

- [ ] **Step 1: Import the shared embed + add family state**

At the top of `main()` (where `extractor` is built today) replace the inline
`embed` closure with the shared one and add the family list. Concretely, after
the `args = parser.parse_args()` line, build the extractor via the shared module:

```python
    from speaker_embed import embed as embed_samples, load_extractor

    extractor = load_extractor(args.embedder)
    family = []  # list[(speaker_id, np.ndarray)] loaded via {"cmd":"load"}
```

Delete the old inline `extractor = so.SpeakerEmbeddingExtractor(...)` block and the
old inline `def embed(samples):` closure (the shared `embed_samples(extractor, …)`
replaces it).

- [ ] **Step 2: Rewrite `handle_segment` to use `decide`**

Replace the whole `handle_segment` function with:

```python
    reference = None
    locked_id = None

    def handle_segment(samples):
        nonlocal reference, locked_id
        vec = embed_samples(extractor, samples)
        pcm16 = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
        audio_b64 = base64.b64encode(pcm16.tobytes()).decode()

        verdict, info = decide(family, reference, vec, args.threshold)
        if verdict == "forward":
            emit({"type": "forward", "audio": audio_b64, "score": 1.0})
        elif verdict == "lock":
            reference = vec
            locked_id = info
            emit({"type": "forward", "audio": audio_b64, "score": 1.0, "speakerId": info})
        elif verdict == "rejected":
            emit({"type": "rejected", "score": round(info, 3)})
        else:  # drop
            emit({"type": "dropped", "score": round(float(np.dot(reference, vec)), 3)})
```

(`reference`/`locked_id` replace the old `reference = None` line; remove the old
one to avoid a duplicate.)

- [ ] **Step 3: Handle the `load` and `reset` control messages**

In the stdin loop, where `{"cmd":"reset"}` is handled, extend it:

```python
            cmd = command.get("cmd")
            if cmd == "reset":
                vad = new_vad()
                reference = None
                locked_id = None
                leftover = np.zeros(0, dtype=np.float32)
            elif cmd == "load":
                family = [
                    (s["id"], np.asarray(s["vec"], dtype=np.float32))
                    for s in command.get("speakers", [])
                    if isinstance(s.get("vec"), list)
                ]
            continue
```

(`family`, `reference`, `locked_id` must be declared `nonlocal`/in-scope of the
loop — they're locals of `main`, so this works since the loop is inside `main`.)

- [ ] **Step 4: Verify it still imports + the pure tests pass**

Run:
```bash
sidecar/.venv/bin/python -c "import speaker_gate; print('import OK')"
sidecar/.venv/bin/python sidecar/test_speakerlock.py
```
Expected: `import OK`, then `PASS`.

- [ ] **Step 5: Commit**

```bash
git add sidecar/speaker_gate.py
git commit -m "feat(speaker): gate matches family voiceprints + hard-locks the wake voice"
```

---

## Task 4: `voiceprintStore.ts`

**Files:** Create `apps/electron/src/main/assistant/voiceprintStore.ts`, `voiceprintStore.test.ts`.

- [ ] **Step 1: Write the failing test** — `voiceprintStore.test.ts` (uses a tiny fake "python" that echoes a vector, so no models needed):

```ts
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { VoiceprintStore } from "./voiceprintStore";

describe("VoiceprintStore", () => {
  let dir: string;
  let fakePy: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fh-vp-"));
    // a fake "python" that ignores args and prints a fixed JSON vector
    fakePy = join(dir, "fakepy.sh");
    await writeFile(fakePy, '#!/bin/sh\necho -n "[0.1, 0.2, 0.3]"\n');
    await chmod(fakePy, 0o755);
  });

  it("computes, stores, loads, and deletes a voiceprint", async () => {
    const store = new VoiceprintStore(dir, fakePy, "ignored.py");
    const clips = join(dir, "speaker-profiles", "spk-1", "clips");
    await mkdir(clips, { recursive: true });

    const vec = await store.compute("spk-1", clips);
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(await store.has("spk-1")).toBe(true);
    expect(await store.load("spk-1")).toEqual([0.1, 0.2, 0.3]);

    const all = await store.loadAll(["spk-1", "spk-2"]); // spk-2 has none
    expect(all).toEqual([{ id: "spk-1", vec: [0.1, 0.2, 0.3] }]);

    await store.delete("spk-1");
    expect(await store.has("spk-1")).toBe(false);
  });
});
```

Run: `cd apps/electron && npx vitest run src/main/assistant/voiceprintStore.test.ts` → FAIL (no module).

- [ ] **Step 2: Implement** — `voiceprintStore.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Voiceprint {
  id: string;
  vec: number[];
}

// Persists a titanet voiceprint per speaker at
// <userData>/speaker-profiles/<id>/voiceprint.json, computed by spawning the
// speaker_embed.py one-shot over the speaker's clips.
export class VoiceprintStore {
  constructor(
    private readonly userDataDirectory: string,
    private readonly pythonPath: string,
    private readonly scriptPath: string,
  ) {}

  private file(speakerId: string): string {
    return join(this.userDataDirectory, "speaker-profiles", speakerId, "voiceprint.json");
  }

  async compute(speakerId: string, clipsDir: string): Promise<number[]> {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.pythonPath, [this.scriptPath, clipsDir]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)),
      );
    });
    const vec = JSON.parse(stdout.trim()) as number[];
    const path = this.file(speakerId);
    await mkdir(join(this.userDataDirectory, "speaker-profiles", speakerId), {
      recursive: true,
    });
    await writeFile(path, JSON.stringify({ dim: vec.length, vec }));
    return vec;
  }

  async load(speakerId: string): Promise<number[] | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(speakerId), "utf8"));
      return Array.isArray(parsed.vec) ? (parsed.vec as number[]) : null;
    } catch {
      return null;
    }
  }

  async has(speakerId: string): Promise<boolean> {
    return (await this.load(speakerId)) !== null;
  }

  async loadAll(speakerIds: string[]): Promise<Voiceprint[]> {
    const out: Voiceprint[] = [];
    for (const id of speakerIds) {
      const vec = await this.load(id);
      if (vec) out.push({ id, vec });
    }
    return out;
  }

  async delete(speakerId: string): Promise<void> {
    await rm(this.file(speakerId), { force: true });
  }
}
```

Run the test → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/electron/src/main/assistant/voiceprintStore.ts apps/electron/src/main/assistant/voiceprintStore.test.ts
git commit -m "feat(speaker): VoiceprintStore computes/stores per-speaker voiceprints"
```

---

## Task 5: `hasVoiceprint` + service `finalizeEnrollment`

**Files:** Modify `types.ts`, `service.ts`, `service.test.ts`.

- [ ] **Step 1: type** — in `types.ts`, add to `EnrolledSpeaker`:

```ts
export interface EnrolledSpeaker extends SpeakerProfileSummary {
  sampleCount: number;
  hasVoiceprint: boolean;
}
```

- [ ] **Step 2: failing test** — in `service.test.ts`, add to the `"enrollment clips"` describe (the service is already constructed with `enrollmentStore`; add a `VoiceprintStore` built on a fake python like Task 4, OR pass an optional fake). Add:

```ts
import { VoiceprintStore } from "./voiceprintStore";
// ... inside a new test, build a fake-python VoiceprintStore as in voiceprintStore.test.ts
it("finalizeEnrollment computes a voiceprint and reports hasVoiceprint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fh-svc-vp-"));
  const fakePy = join(dir, "fakepy.sh");
  await writeFile(fakePy, '#!/bin/sh\necho -n "[1, 0]"\n');
  await chmod(fakePy, 0o755);
  const service = new AssistantService({
    gemini: new PlaceholderGeminiLive(),
    profileStore: new FileSpeakerProfileStore(dir),
    enrollmentStore: new EnrollmentStore(dir),
    voiceprintStore: new VoiceprintStore(dir, fakePy, "x.py"),
  });
  const sp = await service.enrollSpeaker("Mom");
  const b64 = Buffer.from(new Int16Array([1, 2]).buffer).toString("base64");
  await service.saveEnrollmentClip(sp.id, b64);
  await service.finalizeEnrollment(sp.id);
  const snap = await service.getSnapshot();
  expect(snap.speakers.find((s) => s.id === sp.id)?.hasVoiceprint).toBe(true);
});
```
(Add `chmod`, `writeFile`, `mkdtemp`, `tmpdir`, `join` to the test imports if missing.)

Run `cd apps/electron && npx vitest run src/main/assistant/service.test.ts` → FAIL.

- [ ] **Step 3: wire `service.ts`**

1. `import { VoiceprintStore } from "./voiceprintStore";`
2. `AssistantServiceOptions`: add `voiceprintStore?: VoiceprintStore;`
3. Field + constructor: `private readonly voiceprintStore: VoiceprintStore | null;` then `this.voiceprintStore = voiceprintStore ?? null;` (destructure it).
4. In `listEnrolledSpeakers`, add `hasVoiceprint`:
```ts
        ...speaker,
        sampleCount: this.enrollmentStore
          ? await this.enrollmentStore.countClips(speaker.id)
          : 0,
        hasVoiceprint: this.voiceprintStore
          ? await this.voiceprintStore.has(speaker.id)
          : false,
```
5. Add the method:
```ts
  async finalizeEnrollment(speakerId: string): Promise<void> {
    if (!this.enrollmentStore || !this.voiceprintStore) return;
    const clipsDir = this.enrollmentStore.clipsDirOf(speakerId);
    if ((await this.enrollmentStore.countClips(speakerId)) === 0) return;
    try {
      await this.voiceprintStore.compute(speakerId, clipsDir);
    } catch (error) {
      this.pushEvent("error", `Voiceprint failed: ${String(error)}`);
    }
  }
```
6. In `deleteSpeaker`'s `if (deleted)` block, also: `await this.voiceprintStore?.delete(speakerId);`

7. **`EnrollmentStore` needs to expose the clips dir.** In `enrollmentStore.ts` add:
```ts
  clipsDirOf(speakerId: string): string {
    return this.clipsDir(speakerId);
  }
```
(Make `clipsDir` callable — it's currently `private`; add the public `clipsDirOf` that returns it.)

Run the test → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/electron/src/main/assistant/types.ts apps/electron/src/main/assistant/service.ts apps/electron/src/main/assistant/enrollmentStore.ts apps/electron/src/main/assistant/service.test.ts
git commit -m "feat(speaker): service.finalizeEnrollment computes voiceprint; hasVoiceprint in snapshot"
```

---

## Task 6: IPC + preload + d.ts + recorder "Done"

**Files:** Modify `ipc.ts`, `preload/index.ts`, `vite-env.d.ts`, `EnrollmentRecorder.tsx`.

- [ ] **Step 1: ipc.ts** — construct the store + register the handler + pass voiceprints to the controller.

Imports + construction (next to `EnrollmentStore`):
```ts
import { VoiceprintStore } from "./voiceprintStore";
```
```ts
  const voiceprintStore = new VoiceprintStore(
    userDataDirectory,
    sidecarPython,
    resolveSpeakerEmbedScript(),
  );
  const service = new AssistantService({
    gemini,
    profileStore: new FileSpeakerProfileStore(userDataDirectory),
    enrollmentStore: new EnrollmentStore(userDataDirectory),
    voiceprintStore,
  });
```
(For `resolveSpeakerEmbedScript`, mirror the existing `resolveGateScript`/`resolveSidecarScript` helpers in `localTranscriber.ts` — add a sibling there that resolves `speaker_embed.py`, and import it. If a simpler path resolver already exists, reuse it; the script sits next to `speaker_gate.py`.)

Handler (after `assistant:saveEnrollmentClip`):
```ts
  ipcMain.handle("assistant:finalizeEnrollment", async (event, speakerId: unknown) => {
    await service.finalizeEnrollment(requireString(speakerId, "Speaker id"));
    await emitSnapshot(event.sender, service);
  });
```

Pass voiceprints to the controller — where the `LiveController` is constructed
with `createGate`, also pass:
```ts
    getVoiceprints: async () => {
      const speakers = await service.listSpeakers();
      const allowed = speakers.filter((s) => s.allowed).map((s) => s.id);
      return voiceprintStore.loadAll(allowed);
    },
```

- [ ] **Step 2: preload** — add to the `assistant:` bridge:
```ts
    finalizeEnrollment: (speakerId: string) =>
      ipcRenderer.invoke("assistant:finalizeEnrollment", speakerId) as Promise<void>,
```

- [ ] **Step 3: vite-env.d.ts** — `EnrolledSpeaker` gets `hasVoiceprint: boolean;` and `AssistantBridge` gets:
```ts
  finalizeEnrollment: (speakerId: string) => Promise<void>;
```

- [ ] **Step 4: EnrollmentRecorder.tsx** — call it on "Done". Change the Done button's handler from `onClose` to:
```tsx
          <button
            type="button"
            onClick={() => {
              void window.familyHub.assistant.finalizeEnrollment(speakerId);
              onClose();
            }}
          >
            Done
          </button>
```
(Both Done buttons — the idle one and any in the review branch's else path. There is one Done button in the non-review branch; update it.)

- [ ] **Step 5: verify + commit**
```bash
cd apps/electron && npm run typecheck && npx vitest run src/main/assistant
```
```bash
git add apps/electron/src/main/assistant/ipc.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/src/vite-env.d.ts apps/electron/src/renderer/src/EnrollmentRecorder.tsx
git commit -m "feat(speaker): finalizeEnrollment IPC + recorder triggers voiceprint compute"
```

---

## Task 7: `speakerGate.ts` — loadVoiceprints + rejected

**Files:** Modify `speakerGate.ts`.

- [ ] **Step 1: extend the decision type + handlers**

```ts
export interface SpeakerGateDecision {
  type: "enrolled" | "forward" | "dropped" | "rejected";
  score?: number | undefined;
  speakerId?: string | undefined;
}
```

- [ ] **Step 2: handle `"rejected"` from stdout** — in the stdout `line` parser, add a branch alongside `dropped`:
```ts
      } else if (type === "rejected") {
        handlers.onDecision?.({ type: "rejected", score });
      }
```
And on `forward`, pass the optional speakerId:
```ts
      if (type === "forward" && typeof record.audio === "string") {
        handlers.onForward(record.audio);
        handlers.onDecision?.({
          type: "forward",
          score,
          speakerId: typeof record.speakerId === "string" ? record.speakerId : undefined,
        });
      }
```

- [ ] **Step 3: add `loadVoiceprints` to the class + interface**

In `SpeakerGateLike` and `SpeakerGate`:
```ts
  loadVoiceprints(speakers: { id: string; vec: number[] }[]): void;
```
```ts
  loadVoiceprints(speakers: { id: string; vec: number[] }[]): void {
    this.process?.stdin.write(
      `${JSON.stringify({ cmd: "load", speakers })}\n`,
    );
  }
```

- [ ] **Step 4: typecheck + commit**
```bash
cd apps/electron && npm run typecheck
```
```bash
git add apps/electron/src/main/assistant/speakerGate.ts
git commit -m "feat(speaker): gate loadVoiceprints + rejected decision"
```

---

## Task 8: `liveController.ts` — load voiceprints + end on reject

**Files:** Modify `liveController.ts`.

- [ ] **Step 1: add the option** — in the controller's options interface add:
```ts
  getVoiceprints?: () => Promise<{ id: string; vec: number[] }[]>;
```
and store it: `this.getVoiceprints = options.getVoiceprints ?? null;` with a field
`private readonly getVoiceprints: (() => Promise<{ id: string; vec: number[] }[]>) | null;`

- [ ] **Step 2: load voiceprints + handle rejection** — in the block where
`this.gate.start({...})` is called, change the handlers and load after start:
```ts
      await this.gate.start({
        onForward: (audio) => this.session?.sendAudioFrame(audio),
        onDecision: (decision) => {
          if (decision.type === "rejected") {
            this.sink.noteInfo("🔒 not a recognized voice — ending session.");
            void this.closeSession();
          } else if (decision.type === "dropped") {
            this.sink.noteInfo(`🔇 ignored a different voice (${decision.score ?? "?"})`);
          }
        },
      });
      if (this.getVoiceprints) {
        this.gate.loadVoiceprints(await this.getVoiceprints());
      }
```

- [ ] **Step 3: reload voiceprints each new session** — the gate persists across
sessions in this controller; after `this.gate?.reset()` in `connect()`, re-load:
```ts
    this.gate?.reset();
    if (this.gate && this.getVoiceprints) {
      this.gate.loadVoiceprints(await this.getVoiceprints());
    }
```
(Make `connect` already `async` — it is. `reset()` clears the lock; `load` re-seeds
the family before the wake utterance arrives.)

- [ ] **Step 4: verify + commit**
```bash
cd apps/electron && npm run typecheck && npm test
```
```bash
git add apps/electron/src/main/assistant/liveController.ts
git commit -m "feat(speaker): controller loads family voiceprints + ends session on non-family wake"
```

---

## Task 9: Regression + offline speaker verification

**Files:** none (verification only); optionally extend `sidecar/test_speakerlock.py`.

- [ ] **Step 1: full automated gates**
```bash
cd apps/electron && npm run typecheck && npm run lint && npm test
sidecar/.venv/bin/python sidecar/test_speakerlock.py
```
Expected: all green.

- [ ] **Step 2: offline embed sanity (real models, optional but recommended)**

Run a one-off: synthesize two clips of the SAME macOS voice and two DIFFERENT
voices, embed them, and assert same-voice cosine ≫ cross-voice:
```bash
sidecar/.venv/bin/python - <<'PY'
import subprocess, tempfile, os, wave, numpy as np
from speaker_embed import load_extractor, embed
def say(text, voice):
    a=tempfile.mktemp(suffix=".aiff"); w=tempfile.mktemp(suffix=".wav")
    subprocess.run(["say","-v",voice,"-o",a,text],check=True)
    subprocess.run(["afconvert",a,"-o",w,"-d","LEI16@16000","-c","1","-f","WAVE"],check=True)
    s=wave.open(w,"rb"); x=np.frombuffer(s.readframes(s.getnframes()),dtype=np.int16).astype(np.float32)/32768.0
    os.unlink(a); os.unlink(w); return x
e=load_extractor()
d1=embed(e,say("hey james how are you","Daniel"))
d2=embed(e,say("set a timer for ten minutes","Daniel"))
k1=embed(e,say("hey james how are you","Karen"))
print("same-speaker:", round(float(np.dot(d1,d2)),3), "cross-speaker:", round(float(np.dot(d1,k1)),3))
PY
```
Expected: same-speaker cosine clearly higher than cross-speaker (e.g. >0.7 vs <0.55), straddling the 0.6 threshold. If they don't separate, raise/lower `FAMILYHUB_SPEAKER_THRESHOLD` and note it.

- [ ] **Step 3: manual smoke (after deploy)** — rebuild; enroll yourself; confirm:
James wakes to *your* voice and replies; a different person (or the TV) saying
"James" wakes detection but the session **ends immediately** ("not a recognized
voice"); during your session, another person's voice is ignored.

---

## Notes for the implementer

- **No jsdom/RTL** — renderer tests are pure-function only. Components verified by running the app.
- **Open-mic fallback is load-bearing:** with no voiceprints enrolled, `decide([], None, emb, t)` returns `("lock", None)` so James still works pre-enrollment. Don't "tighten" this to reject-when-empty.
- **The gate persists across sessions** in `LiveController`; `reset()` clears the per-session lock but the family list must be re-`load`ed each session (Task 8 Step 3).
- **Scope discipline:** every `git add` names exact files — never `git add -A`. The branch has unrelated WIP.
- Depends on SP1 (`EnrollmentStore`, `EnrolledSpeaker`, the recorder) — already merged.
