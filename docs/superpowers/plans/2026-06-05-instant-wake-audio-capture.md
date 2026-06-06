# Instant-Wake Audio Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user say "James" and immediately keep talking — capture everything spoken during wake-detection + Gemini connect and replay it into the Live session on open, with an always-on local Parakeet listener replacing the per-chunk Google Speech wake path.

**Architecture:** The renderer becomes a dumb audio device that streams every mic frame to main. The main process runs a long-lived Parakeet sidecar (always-on local ASR), keeps a bounded pre-roll, detects "James", opens Gemini Live, buffers frames across the connect, and flushes them in exact order on open. The buffering/seam logic lives in a **pure, fully-tested state machine**; the impure glue (sidecar process, websocket, timers) lives in a `LiveController`.

**Tech Stack:** Electron 42 + electron-vite, TypeScript, React 19, Vitest, `@google/genai` (Gemini Live), Python 3.11/3.12 + `parakeet-mlx` (Apple-Silicon MLX) sidecar.

**Reference spec:** `docs/superpowers/specs/2026-06-05-instant-wake-audio-capture-design.md`

---

## File Structure

**New (main process):**
- `apps/electron/src/main/assistant/listenerMachine.ts` — pure seam state machine (owns bounded pre-roll + flush queue).
- `apps/electron/src/main/assistant/listenerMachine.test.ts`
- `apps/electron/src/main/assistant/localTranscriber.ts` — `LocalTranscriber` interface, pure `parseTranscriptLine`, sidecar path resolution, and `ParakeetSidecarTranscriber` spawner.
- `apps/electron/src/main/assistant/localTranscriber.test.ts`
- `apps/electron/src/main/assistant/liveController.ts` — impure glue tying machine + transcriber + Gemini session.
- `apps/electron/src/main/assistant/liveController.test.ts`

**New (sidecar):**
- `sidecar/parakeet_listener.py` — streaming ASR sidecar.
- `sidecar/requirements.txt`
- `sidecar/setup.sh`
- `sidecar/README.md`

**Modified:**
- `apps/electron/src/main/assistant/ipc.ts` — instantiate `LiveController`, route mic frames, drop `detectWake`.
- `apps/electron/src/main/assistant/config.ts` — `localListener` probe.
- `apps/electron/src/main/assistant/types.ts` — `AssistantConfigStatus.localListener`.
- `apps/electron/src/preload/index.ts` — rename `sendLiveFrame`→`sendMicFrame`, drop `detectWake`.
- `apps/electron/src/renderer/src/vite-env.d.ts` — bridge + config type updates.
- `apps/electron/src/renderer/src/App.tsx` — always-stream mic, remove wake-chunk/detectWake path, provider row, connecting status.
- `apps/electron/electron.vite.config.ts` / `apps/electron/package.json` — bundle `sidecar/` as `extraResources` (mac).
- `README.md` — document the sidecar setup.

---

## Task 0: Initialize git (if needed)

The working tree is not yet a git repository, but the plan commits after every task.

- [ ] **Step 1: Check for a repo**

Run: `git -C /Users/tedyeng1/Pessoal/FamilyHub rev-parse --is-inside-work-tree 2>/dev/null || echo "no repo"`
Expected: `no repo` (or `true` if one already exists — then skip to Task 1).

- [ ] **Step 2: Initialize and make a baseline commit**

```bash
cd /Users/tedyeng1/Pessoal/FamilyHub
git init
git add -A
git commit -m "chore: baseline before instant-wake audio capture"
```

Expected: a commit is created. (`node_modules/`, `out/`, `release/` should already be covered by `.gitignore`; if `git status` shows them, add them to `.gitignore` first.)

---

## Task 1: Listener state machine (the seam)

This is the heart of the feature: a pure reducer that buffers frames across the connect and flushes them exactly once, in order. It owns a bounded pre-roll (so words spoken right after "James" — before detection finishes — are not lost) and a bounded flush queue (to cap memory on a slow connect).

**Files:**
- Create: `apps/electron/src/main/assistant/listenerMachine.ts`
- Test: `apps/electron/src/main/assistant/listenerMachine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/electron/src/main/assistant/listenerMachine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createListenerState,
  defaultListenerConfig,
  reduceListener,
  type ListenerEffect,
  type ListenerEvent,
  type ListenerState,
} from "./listenerMachine";

// Drives a sequence of events through the reducer, returning the final state
// and the flat list of every frame handed to "sendFrames", in emission order.
function run(
  events: ListenerEvent[],
  config = defaultListenerConfig,
): { state: ListenerState; sent: string[]; effects: ListenerEffect[] } {
  let state = createListenerState();
  const sent: string[] = [];
  const effects: ListenerEffect[] = [];

  for (const event of events) {
    const result = reduceListener(state, event, config);
    state = result.state;

    for (const effect of result.effects) {
      effects.push(effect);

      if (effect.type === "sendFrames") {
        sent.push(...effect.frames);
      }
    }
  }

  return { state, sent, effects };
}

describe("reduceListener", () => {
  it("buffers idle frames into the pre-roll without sending", () => {
    const { state, sent } = run([
      { type: "frame", frame: "p1" },
      { type: "frame", frame: "p2" },
    ]);

    expect(state.phase).toBe("idle");
    expect(state.preRoll).toEqual(["p1", "p2"]);
    expect(sent).toEqual([]);
  });

  it("caps the pre-roll at maxPrerollFrames, dropping the oldest", () => {
    const { state } = run(
      [
        { type: "frame", frame: "p1" },
        { type: "frame", frame: "p2" },
        { type: "frame", frame: "p3" },
      ],
      { maxPrerollFrames: 2, maxQueueFrames: 100 },
    );

    expect(state.preRoll).toEqual(["p2", "p3"]);
  });

  it("seeds the queue from the pre-roll and requests connect on wake", () => {
    const { state, effects, sent } = run([
      { type: "frame", frame: "p1" },
      { type: "frame", frame: "p2" },
      { type: "wake" },
    ]);

    expect(state.phase).toBe("connecting");
    expect(state.preRoll).toEqual([]);
    expect(state.queue).toEqual(["p1", "p2"]);
    expect(effects).toContainEqual({ type: "connect" });
    expect(sent).toEqual([]); // nothing sent until the socket opens
  });

  it("delivers pre-roll + connecting frames + live frames exactly once, in order", () => {
    const { state, sent } = run([
      { type: "frame", frame: "p1" }, // pre-roll
      { type: "frame", frame: "p2" }, // pre-roll
      { type: "wake" },
      { type: "frame", frame: "c1" }, // buffered during connect
      { type: "frame", frame: "c2" },
      { type: "sessionOpen" }, // flush p1,p2,c1,c2
      { type: "frame", frame: "l1" }, // streamed live
      { type: "frame", frame: "l2" },
    ]);

    expect(state.phase).toBe("live");
    expect(state.queue).toEqual([]);
    expect(sent).toEqual(["p1", "p2", "c1", "c2", "l1", "l2"]);
  });

  it("caps the connecting queue at maxQueueFrames, dropping the oldest", () => {
    const { sent } = run(
      [
        { type: "wake" },
        { type: "frame", frame: "c1" },
        { type: "frame", frame: "c2" },
        { type: "frame", frame: "c3" },
        { type: "sessionOpen" },
      ],
      { maxPrerollFrames: 10, maxQueueFrames: 2 },
    );

    expect(sent).toEqual(["c2", "c3"]);
  });

  it("returns to idle and sends nothing when the connect fails", () => {
    const { state, sent } = run([
      { type: "wake" },
      { type: "frame", frame: "c1" },
      { type: "sessionClosed" }, // connect failed before open
    ]);

    expect(state.phase).toBe("idle");
    expect(state.queue).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("ignores wake while connecting or live", () => {
    const { effects } = run([
      { type: "wake" },
      { type: "wake" },
      { type: "sessionOpen" },
      { type: "wake" },
    ]);

    expect(effects.filter((effect) => effect.type === "connect")).toHaveLength(1);
  });

  it("on stop, requests close, ignores frames while closing, then idles", () => {
    const { state, effects, sent } = run([
      { type: "wake" },
      { type: "sessionOpen" },
      { type: "stop" },
      { type: "frame", frame: "late" }, // arrives during teardown
      { type: "sessionClosed" },
    ]);

    expect(effects).toContainEqual({ type: "closeSession" });
    expect(sent).toEqual([]); // "late" must not be streamed
    expect(state.phase).toBe("idle");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace @family-hub/electron run test -- src/main/assistant/listenerMachine.test.ts`
Expected: FAIL — `Cannot find module './listenerMachine'`.

- [ ] **Step 3: Implement the state machine**

Create `apps/electron/src/main/assistant/listenerMachine.ts`:

```ts
// Pure, side-effect-free model of the wake → connect → live handoff.
//
// The renderer streams every mic frame to the main process continuously. While
// idle we keep a bounded rolling pre-roll so that the words spoken immediately
// after "James" — before the local ASR has finished recognising the wake word —
// are not lost. On wake we seed a flush queue from the pre-roll and keep
// appending frames while Gemini Live connects. When the socket opens we flush
// the whole queue once, in order, then stream subsequent frames straight
// through. Because no frame is ever sent before the socket opens, delivery is
// exactly-once with no fuzzy de-duplication required.

export type ListenerPhase = "idle" | "connecting" | "live" | "closing";

export interface ListenerState {
  phase: ListenerPhase;
  preRoll: string[];
  queue: string[];
  sessionOpen: boolean;
}

export type ListenerEvent =
  | { type: "frame"; frame: string }
  | { type: "wake" }
  | { type: "sessionOpen" }
  | { type: "sessionClosed" }
  | { type: "stop" };

export type ListenerEffect =
  | { type: "connect" }
  | { type: "sendFrames"; frames: string[] }
  | { type: "closeSession" };

export interface ListenerConfig {
  maxPrerollFrames: number;
  maxQueueFrames: number;
}

// At the renderer's ~120 ms frame cadence, 24 frames ≈ 3 s of pre-roll and
// 250 frames ≈ 30 s of buffered audio across a slow connect.
export const defaultListenerConfig: ListenerConfig = {
  maxPrerollFrames: 24,
  maxQueueFrames: 250,
};

export function createListenerState(): ListenerState {
  return { phase: "idle", preRoll: [], queue: [], sessionOpen: false };
}

interface Transition {
  state: ListenerState;
  effects: ListenerEffect[];
}

export function reduceListener(
  state: ListenerState,
  event: ListenerEvent,
  config: ListenerConfig = defaultListenerConfig,
): Transition {
  switch (state.phase) {
    case "idle":
      if (event.type === "frame") {
        return {
          state: {
            ...state,
            preRoll: boundedPush(state.preRoll, event.frame, config.maxPrerollFrames),
          },
          effects: [],
        };
      }

      if (event.type === "wake") {
        return {
          state: { ...state, phase: "connecting", queue: state.preRoll, preRoll: [] },
          effects: [{ type: "connect" }],
        };
      }

      return { state, effects: [] };

    case "connecting":
      if (event.type === "frame") {
        return {
          state: {
            ...state,
            queue: boundedPush(state.queue, event.frame, config.maxQueueFrames),
          },
          effects: [],
        };
      }

      if (event.type === "sessionOpen") {
        return {
          state: { ...state, phase: "live", sessionOpen: true, queue: [] },
          effects:
            state.queue.length > 0
              ? [{ type: "sendFrames", frames: state.queue }]
              : [],
        };
      }

      if (event.type === "sessionClosed") {
        return { state: createListenerState(), effects: [] };
      }

      if (event.type === "stop") {
        return {
          state: { ...createListenerState(), phase: "closing" },
          effects: [{ type: "closeSession" }],
        };
      }

      return { state, effects: [] };

    case "live":
      if (event.type === "frame") {
        return { state, effects: [{ type: "sendFrames", frames: [event.frame] }] };
      }

      if (event.type === "sessionClosed") {
        return { state: createListenerState(), effects: [] };
      }

      if (event.type === "stop") {
        return {
          state: { ...createListenerState(), phase: "closing" },
          effects: [{ type: "closeSession" }],
        };
      }

      return { state, effects: [] };

    case "closing":
      if (event.type === "sessionClosed") {
        return { state: createListenerState(), effects: [] };
      }

      return { state, effects: [] };
  }
}

function boundedPush(items: string[], item: string, max: number): string[] {
  const next = [...items, item];
  return next.length > max ? next.slice(next.length - max) : next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace @family-hub/electron run test -- src/main/assistant/listenerMachine.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/assistant/listenerMachine.ts apps/electron/src/main/assistant/listenerMachine.test.ts
git commit -m "feat(assistant): pure listener state machine for wake→connect→live seam"
```

---

## Task 2: Local transcriber contract, parser, and sidecar paths

Defines the `LocalTranscriber` interface, a pure parser for the sidecar's stdout JSON lines, and path resolution shared with the config probe. The Python process itself comes in Task 3 and the spawner in Task 4.

**Files:**
- Create: `apps/electron/src/main/assistant/localTranscriber.ts`
- Test: `apps/electron/src/main/assistant/localTranscriber.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/electron/src/main/assistant/localTranscriber.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseTranscriptLine } from "./localTranscriber";

describe("parseTranscriptLine", () => {
  it("parses a partial transcript with words", () => {
    expect(
      parseTranscriptLine(
        '{"type":"partial","text":"james turn on","words":[{"word":"james","startMs":0,"endMs":200}]}',
      ),
    ).toEqual({
      type: "partial",
      text: "james turn on",
      words: [{ word: "james", startMs: 0, endMs: 200 }],
    });
  });

  it("parses a final transcript and defaults missing words to []", () => {
    expect(parseTranscriptLine('{"type":"final","text":"hello"}')).toEqual({
      type: "final",
      text: "hello",
      words: [],
    });
  });

  it("defaults a missing text to an empty string", () => {
    expect(parseTranscriptLine('{"type":"partial"}')).toEqual({
      type: "partial",
      text: "",
      words: [],
    });
  });

  it("drops malformed word entries", () => {
    expect(
      parseTranscriptLine(
        '{"type":"partial","text":"x","words":[{"word":"x","startMs":1,"endMs":2},{"nope":true}]}',
      ),
    ).toEqual({
      type: "partial",
      text: "x",
      words: [{ word: "x", startMs: 1, endMs: 2 }],
    });
  });

  it("returns null for blank lines, invalid JSON, and unknown types", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine("   ")).toBeNull();
    expect(parseTranscriptLine("not json")).toBeNull();
    expect(parseTranscriptLine("[1,2,3]")).toBeNull();
    expect(parseTranscriptLine('{"type":"weird","text":"x"}')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace @family-hub/electron run test -- src/main/assistant/localTranscriber.test.ts`
Expected: FAIL — `Cannot find module './localTranscriber'`.

- [ ] **Step 3: Implement the contract, parser, and path resolution**

Create `apps/electron/src/main/assistant/localTranscriber.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptMessage {
  type: "partial" | "final";
  text: string;
  words: TranscriptWord[];
}

export interface LocalTranscriberHandlers {
  onTranscript: (message: TranscriptMessage) => void;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
}

// The always-on local ASR. Implementations stream 16 kHz LINEAR16 frames
// (base64) in and emit transcript messages out. `reset()` clears the running
// transcript so a previous "James …" cannot re-trigger the next wake.
export interface LocalTranscriber {
  start(handlers: LocalTranscriberHandlers): Promise<void>;
  write(pcmBase64: string): void;
  reset(): void;
  stop(): Promise<void>;
}

// Pure: one stdout line → a transcript message, or null if it is not one.
export function parseTranscriptLine(line: string): TranscriptMessage | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const type =
    record.type === "final" ? "final" : record.type === "partial" ? "partial" : null;

  if (type === null) {
    return null;
  }

  const text = typeof record.text === "string" ? record.text : "";
  const words = Array.isArray(record.words)
    ? record.words
        .map(parseWord)
        .filter((word): word is TranscriptWord => word !== null)
    : [];

  return { type, text, words };
}

function parseWord(value: unknown): TranscriptWord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.word !== "string" ||
    typeof record.startMs !== "number" ||
    typeof record.endMs !== "number"
  ) {
    return null;
  }

  return { word: record.word, startMs: record.startMs, endMs: record.endMs };
}

// Resolve the bundled sidecar's Python interpreter and entry script. Dev runs
// from `apps/electron`; packaging copies `sidecar/` into resources. Env vars
// override both for custom installs.
export function resolveSidecarPython(): string | null {
  if (process.env.FAMILYHUB_SIDECAR_PYTHON) {
    return process.env.FAMILYHUB_SIDECAR_PYTHON;
  }

  return firstExisting(
    sidecarRoots().map((root) => resolve(root, ".venv/bin/python")),
  );
}

export function resolveSidecarScript(): string | null {
  if (process.env.FAMILYHUB_SIDECAR_SCRIPT) {
    return process.env.FAMILYHUB_SIDECAR_SCRIPT;
  }

  return firstExisting(
    sidecarRoots().map((root) => resolve(root, "parakeet_listener.py")),
  );
}

function sidecarRoots(): string[] {
  const roots = [
    resolve(process.cwd(), "sidecar"),
    resolve(process.cwd(), "../../sidecar"),
  ];

  if (process.resourcesPath) {
    roots.push(resolve(process.resourcesPath, "sidecar"));
  }

  return roots;
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

// Long-lived Parakeet sidecar. Communicates over stdio: base64 audio lines in,
// JSON transcript lines out. A line beginning with "{" on stdin is a control
// command (base64 never starts with "{").
export class ParakeetSidecarTranscriber implements LocalTranscriber {
  private process: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly pythonPath: string,
    private readonly scriptPath: string,
    private readonly model = "mlx-community/parakeet-tdt-0.6b-v3",
  ) {}

  async start(handlers: LocalTranscriberHandlers): Promise<void> {
    if (this.process) {
      return;
    }

    const child = spawn(this.pythonPath, [this.scriptPath, "--model", this.model], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const message = parseTranscriptLine(line);

      if (message) {
        handlers.onTranscript(message);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      handlers.onError(chunk.toString().trim());
    });

    child.on("exit", (code) => {
      this.process = null;
      handlers.onExit(code);
    });

    child.on("error", (error) => {
      handlers.onError(error.message);
    });
  }

  write(pcmBase64: string): void {
    this.process?.stdin.write(`${pcmBase64}\n`);
  }

  reset(): void {
    this.process?.stdin.write(`${JSON.stringify({ cmd: "reset" })}\n`);
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = null;

    if (!child) {
      return;
    }

    await new Promise<void>((resolveStop) => {
      child.once("exit", () => resolveStop());
      child.stdin.end();
      child.kill("SIGTERM");
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace @family-hub/electron run test -- src/main/assistant/localTranscriber.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/assistant/localTranscriber.ts apps/electron/src/main/assistant/localTranscriber.test.ts
git commit -m "feat(assistant): LocalTranscriber contract, transcript parser, sidecar paths"
```

---

## Task 3: Parakeet Python sidecar

The always-on local ASR process. Reads base64 16 kHz LINEAR16 frames on stdin, streams them through Parakeet, and emits running-transcript JSON lines on stdout. Handles a `{"cmd":"reset"}` control line to restart its streaming context.

**Files:**
- Create: `sidecar/parakeet_listener.py`
- Create: `sidecar/requirements.txt`
- Create: `sidecar/setup.sh`
- Create: `sidecar/README.md`

- [ ] **Step 1: Write the sidecar script**

Create `sidecar/parakeet_listener.py`:

```python
#!/usr/bin/env python3
"""FamilyHub always-on local ASR sidecar (Apple Silicon / MLX).

Protocol (newline-delimited over stdio):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line, OR a JSON control
           line such as {"cmd": "reset"} (base64 never starts with "{").
  stdout : one JSON object per line:
             {"type": "partial"|"final", "text": str,
              "words": [{"word": str, "startMs": int, "endMs": int}]}

The first emitted line is {"type":"partial","text":"","words":[]} as a ready
signal once the model has loaded.
"""

import argparse
import base64
import json
import sys

import numpy as np


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def words_from_result(result):
    words = []
    for sentence in getattr(result, "sentences", None) or []:
        for token in getattr(sentence, "tokens", None) or []:
            text = getattr(token, "text", "")
            start = getattr(token, "start", 0.0) or 0.0
            end = getattr(token, "end", 0.0) or 0.0
            words.append(
                {
                    "word": text,
                    "startMs": int(start * 1000),
                    "endMs": int(end * 1000),
                }
            )
    return words


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3")
    args = parser.parse_args()

    # Imported lazily so a missing dependency surfaces on stderr, not at import.
    import mlx.core as mx
    from parakeet_mlx import from_pretrained

    model = from_pretrained(args.model)

    # NOTE: integration point — confirm `transcribe_stream` exists with this
    # signature in the installed parakeet-mlx version (see Step 4). The context
    # manager yields a streaming transcriber exposing `.add_audio(mx.array)` and
    # a `.result` with `.text` and `.sentences[].tokens[]`.
    def open_stream():
        cm = model.transcribe_stream(context_size=(256, 256))
        return cm, cm.__enter__()

    stream_cm, stream = open_stream()
    emit({"type": "partial", "text": "", "words": []})  # ready signal

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        if line.startswith("{"):
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if command.get("cmd") == "reset":
                stream_cm.__exit__(None, None, None)
                stream_cm, stream = open_stream()
            continue

        try:
            raw = base64.b64decode(line)
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        except Exception:  # noqa: BLE001 - skip an unparseable frame
            continue

        if samples.size == 0:
            continue

        stream.add_audio(mx.array(samples))
        result = stream.result
        emit(
            {
                "type": "partial",
                "text": getattr(result, "text", "") or "",
                "words": words_from_result(result),
            }
        )

    try:
        stream_cm.__exit__(None, None, None)
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write the dependency + setup files**

Create `sidecar/requirements.txt`:

```text
parakeet-mlx
numpy
```

Create `sidecar/setup.sh`:

```bash
#!/usr/bin/env bash
# Creates the local Python venv for the Parakeet sidecar (Apple Silicon only).
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

"$PYTHON_BIN" -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

echo "Sidecar venv ready at $(pwd)/.venv"
echo "The Parakeet model (~600 MB) downloads on first run and is cached by Hugging Face."
```

Create `sidecar/README.md`:

```markdown
# FamilyHub Parakeet sidecar

Always-on local ASR for the "James" wake word and post-wake capture. Apple
Silicon only (uses MLX).

## Setup

```bash
cd sidecar
./setup.sh
```

This creates `sidecar/.venv`. The Electron main process auto-discovers
`sidecar/.venv/bin/python` and `sidecar/parakeet_listener.py`. Override with
`FAMILYHUB_SIDECAR_PYTHON` / `FAMILYHUB_SIDECAR_SCRIPT`.

## Smoke test

```bash
printf '%s\n' "$(python3 -c 'import base64,sys; sys.stdout.write(base64.b64encode(bytes(3200)).decode())')" \
  | ./.venv/bin/python parakeet_listener.py
```

Expected: at least one JSON line on stdout, beginning with the ready signal
`{"type": "partial", "text": "", "words": []}`.
```

- [ ] **Step 3: Make scripts executable and create the venv**

```bash
chmod +x sidecar/setup.sh sidecar/parakeet_listener.py
cd /Users/tedyeng1/Pessoal/FamilyHub/sidecar && ./setup.sh
```

Expected: `Sidecar venv ready at …/sidecar/.venv`. (If `parakeet-mlx` fails to install, confirm Python is 3.11 or 3.12 and you are on Apple Silicon.)

- [ ] **Step 4: Verify the sidecar runs and the streaming API matches**

```bash
cd /Users/tedyeng1/Pessoal/FamilyHub/sidecar
printf '%s\n' "$(python3 -c 'import base64; print(base64.b64encode(bytes(6400)).decode())')" \
  | ./.venv/bin/python parakeet_listener.py
```

Expected: stdout shows the ready signal line and at least one further `partial` line; **no `AttributeError`/`TypeError` on stderr**. If `transcribe_stream` or the result shape differs in the installed version, adjust `open_stream()` / `words_from_result()` to match (this is the one place the external API is assumed) and re-run until it produces transcript lines for real speech.

- [ ] **Step 5: Ignore the venv and model cache, then commit**

Add to `.gitignore` (root):

```text
sidecar/.venv/
```

```bash
git add sidecar/parakeet_listener.py sidecar/requirements.txt sidecar/setup.sh sidecar/README.md .gitignore
git commit -m "feat(sidecar): Parakeet streaming ASR sidecar for local wake + capture"
```

---

## Task 4: LiveController integration

The impure glue: owns the transcriber + Gemini session, applies the pure machine, detects wake from transcripts, executes effects (connect / sendFrames / closeSession), and moves the Gemini event handling (input/output buffers, audio passthrough, `end_conversation`, idle timeout) out of `ipc.ts`. Dependencies are injected so it is testable with fakes.

**Files:**
- Create: `apps/electron/src/main/assistant/liveController.ts`
- Test: `apps/electron/src/main/assistant/liveController.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `apps/electron/src/main/assistant/liveController.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { LiveController, type LiveControllerSink, type LiveSessionLike } from "./liveController";
import type { LiveSessionHandlers } from "./liveSession";
import type { LocalTranscriber, LocalTranscriberHandlers } from "./localTranscriber";

class FakeTranscriber implements LocalTranscriber {
  handlers: LocalTranscriberHandlers | null = null;
  writes: string[] = [];
  resets = 0;

  async start(handlers: LocalTranscriberHandlers): Promise<void> {
    this.handlers = handlers;
  }

  write(frame: string): void {
    this.writes.push(frame);
  }

  reset(): void {
    this.resets += 1;
  }

  async stop(): Promise<void> {}

  emit(text: string): void {
    this.handlers?.onTranscript({ type: "partial", text, words: [] });
  }
}

class FakeSession implements LiveSessionLike {
  handlers: LiveSessionHandlers | null = null;
  sentFrames: string[] = [];
  closed = false;

  async start(handlers: LiveSessionHandlers): Promise<void> {
    this.handlers = handlers;
  }

  sendAudioFrame(frame: string): void {
    this.sentFrames.push(frame);
  }

  sendToolResponse(): void {}

  async close(): Promise<void> {
    this.closed = true;
    this.handlers?.onClosed("closed");
  }
}

function createSink(): LiveControllerSink & { live: unknown[] } {
  const live: unknown[] = [];
  return {
    live,
    sendLive: (event) => live.push(event),
    sendLiveAudio: () => {},
    noteHeard: () => {},
    noteAssistantReply: () => {},
    noteInfo: () => {},
    emitSnapshot: () => {},
  };
}

async function setup() {
  const transcriber = new FakeTranscriber();
  const sessions: FakeSession[] = [];
  const sink = createSink();
  const controller = new LiveController({
    createTranscriber: () => transcriber,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    sink,
  });
  await controller.start();
  return { controller, transcriber, sessions, sink };
}

describe("LiveController", () => {
  it("captures across connect and replays pre-roll + buffered + live frames once, in order", async () => {
    const { controller, transcriber, sessions } = await setup();

    controller.handleFrame("p1"); // pre-roll
    controller.handleFrame("p2");
    transcriber.emit("james turn on the lights"); // wake → connect

    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    controller.handleFrame("c1"); // buffered during connect (or streamed if already open)

    // Simulate the socket opening: controller dispatches sessionOpen after
    // session.start() resolves, which already happened in waitFor above. Frames
    // sent after open stream straight through.
    await vi.waitFor(() => expect(sessions[0].sentFrames.length).toBeGreaterThan(0));

    controller.handleFrame("l1");

    expect(sessions[0].sentFrames).toEqual(["p1", "p2", "c1", "l1"]);
  });

  it("feeds every frame to the transcriber and resets it on start", async () => {
    const { controller, transcriber } = await setup();
    expect(transcriber.resets).toBe(1); // reset on start

    controller.handleFrame("a");
    controller.handleFrame("b");

    expect(transcriber.writes).toEqual(["a", "b"]);
  });

  it("ignores a second wake while a session is active", async () => {
    const { controller, transcriber, sessions } = await setup();

    transcriber.emit("james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    transcriber.emit("james again");
    await new Promise((r) => setTimeout(r, 10));

    expect(sessions).toHaveLength(1);
  });

  it("closes the session on stop and returns to wake mode", async () => {
    const { controller, transcriber, sessions, sink } = await setup();

    transcriber.emit("james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    await controller.endLive();
    await vi.waitFor(() => expect(sessions[0].closed).toBe(true));

    expect(sink.live).toContainEqual({ type: "mode", mode: "wake" });
  });
});
```

> Note on the test: because `FakeSession.start()` resolves immediately, the controller dispatches `sessionOpen` right after `createSession`, so by the time `c1`/`l1` are sent the queue has been flushed — the assertion checks the exact ordered union.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace @family-hub/electron run test -- src/main/assistant/liveController.test.ts`
Expected: FAIL — `Cannot find module './liveController'`.

- [ ] **Step 3: Implement the controller**

Create `apps/electron/src/main/assistant/liveController.ts`:

```ts
import { transcriptContainsWakePhrase } from "./gating";
import {
  createListenerState,
  defaultListenerConfig,
  reduceListener,
  type ListenerConfig,
  type ListenerEffect,
  type ListenerEvent,
  type ListenerState,
} from "./listenerMachine";
import { endConversationToolName, type LiveEvent, type LiveSessionHandlers } from "./liveSession";
import type { LocalTranscriber } from "./localTranscriber";

// The subset of GeminiLiveSession the controller depends on (so tests can fake
// it without a websocket).
export interface LiveSessionLike {
  start(handlers: LiveSessionHandlers): Promise<void>;
  sendAudioFrame(frame: string): void;
  sendToolResponse(id: string, name: string, response: Record<string, unknown>): void;
  close(): Promise<void>;
}

export type LiveStateEvent =
  | { type: "mode"; mode: "wake" | "live" }
  | { type: "inputTranscript"; text: string }
  | { type: "outputTranscript"; text: string }
  | { type: "status"; message: string }
  | { type: "interrupted" }
  | { type: "turnComplete" };

// How the controller talks back to the renderer and the snapshot panels.
export interface LiveControllerSink {
  sendLive(event: LiveStateEvent): void;
  sendLiveAudio(chunk: { data: string; mimeType: string }): void;
  noteHeard(text: string): void;
  noteAssistantReply(text: string): void;
  noteInfo(message: string): void;
  emitSnapshot(): void;
}

export interface LiveControllerOptions {
  createTranscriber: () => LocalTranscriber;
  createSession: () => LiveSessionLike;
  sink: LiveControllerSink;
  wakePhrases?: string[];
  config?: ListenerConfig;
  idleTimeoutMs?: number;
}

const defaultWakePhrases = ["james"];
const defaultIdleTimeoutMs = 18_000;

export class LiveController {
  private readonly createTranscriber: () => LocalTranscriber;
  private readonly createSession: () => LiveSessionLike;
  private readonly sink: LiveControllerSink;
  private readonly wakePhrases: string[];
  private readonly config: ListenerConfig;
  private readonly idleTimeoutMs: number;

  private transcriber: LocalTranscriber | null = null;
  private session: LiveSessionLike | null = null;
  private state: ListenerState = createListenerState();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private endFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = true;
  private endRequested = false;
  private endReason = "goodbye";
  private inputTurnBuffer = "";
  private outputTurnBuffer = "";

  constructor(options: LiveControllerOptions) {
    this.createTranscriber = options.createTranscriber;
    this.createSession = options.createSession;
    this.sink = options.sink;
    this.wakePhrases = options.wakePhrases ?? defaultWakePhrases;
    this.config = options.config ?? defaultListenerConfig;
    this.idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.transcriber) {
      return;
    }

    const transcriber = this.createTranscriber();
    this.transcriber = transcriber;

    await transcriber.start({
      onTranscript: (message) => this.handleTranscript(message.text),
      onError: (message) => this.sink.noteInfo(`Listener error: ${message}`),
      onExit: () => this.sink.noteInfo("Listener stopped."),
    });

    transcriber.reset();
  }

  handleFrame(frame: string): void {
    this.transcriber?.write(frame);
    this.apply({ type: "frame", frame });
  }

  async endLive(): Promise<void> {
    this.apply({ type: "stop" });
  }

  async stop(): Promise<void> {
    this.apply({ type: "stop" });
    const transcriber = this.transcriber;
    this.transcriber = null;
    await transcriber?.stop();
  }

  private handleTranscript(text: string): void {
    if (this.state.phase !== "idle") {
      return;
    }

    if (transcriptContainsWakePhrase(text, this.wakePhrases)) {
      this.apply({ type: "wake" });
    }
  }

  private apply(event: ListenerEvent): void {
    const { state, effects } = reduceListener(this.state, event, this.config);
    this.state = state;

    for (const effect of effects) {
      this.runEffect(effect);
    }
  }

  private runEffect(effect: ListenerEffect): void {
    switch (effect.type) {
      case "connect":
        void this.connect();
        break;
      case "sendFrames":
        for (const frame of effect.frames) {
          this.session?.sendAudioFrame(frame);
        }
        break;
      case "closeSession":
        void this.closeSession();
        break;
    }
  }

  private async connect(): Promise<void> {
    const session = this.createSession();
    this.session = session;
    this.finalized = false;
    this.endRequested = false;
    this.inputTurnBuffer = "";
    this.outputTurnBuffer = "";
    this.sink.sendLive({ type: "status", message: "Connecting…" });

    try {
      await session.start({
        onEvent: (event) => this.handleLiveEvent(event),
        onClosed: (reason) => this.finalize(reason),
        onError: (message) => this.sink.sendLive({ type: "status", message }),
      });
    } catch (error) {
      this.finalize(`could not connect: ${readErrorMessage(error)}`);
      return;
    }

    this.apply({ type: "sessionOpen" });
    this.sink.noteInfo("Wake word heard — live session started.");
    this.sink.sendLive({ type: "mode", mode: "live" });
    this.sink.sendLive({ type: "status", message: "Live — go ahead and talk." });
    this.sink.emitSnapshot();
    this.armIdleTimer();
  }

  private async closeSession(): Promise<void> {
    const session = this.session;

    if (!session) {
      this.finalize("stopped");
      return;
    }

    await session.close(); // triggers onClosed → finalize
  }

  private finalize(reason: string): void {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.session = null;
    this.clearTimers();
    this.inputTurnBuffer = "";
    this.outputTurnBuffer = "";

    if (this.state.phase !== "idle") {
      this.apply({ type: "sessionClosed" });
    }

    this.transcriber?.reset();
    this.sink.noteInfo(`Live session ended (${reason}).`);
    this.sink.sendLive({ type: "status", message: `Session ended (${reason}).` });
    this.sink.sendLive({ type: "mode", mode: "wake" });
    this.sink.emitSnapshot();
  }

  // Moved verbatim in spirit from ipc.ts handleLiveEvent.
  private handleLiveEvent(event: LiveEvent): void {
    switch (event.kind) {
      case "inputTranscript":
        this.inputTurnBuffer += event.text;
        this.armIdleTimer();
        this.sink.sendLive({ type: "inputTranscript", text: this.inputTurnBuffer });
        break;
      case "outputTranscript":
        this.outputTurnBuffer += event.text;
        this.sink.sendLive({ type: "outputTranscript", text: this.outputTurnBuffer });
        break;
      case "audio":
        this.sink.sendLiveAudio({ data: event.data, mimeType: event.mimeType });
        break;
      case "toolCall":
        if (event.name === endConversationToolName) {
          this.session?.sendToolResponse(event.id, event.name, { status: "ended" });
          this.endRequested = true;
          this.endReason =
            typeof event.args.reason === "string" && event.args.reason.trim()
              ? event.args.reason.trim()
              : "said goodbye";

          if (this.endFallbackTimer) {
            clearTimeout(this.endFallbackTimer);
          }

          this.endFallbackTimer = setTimeout(() => this.apply({ type: "stop" }), 5_000);
        }
        break;
      case "interrupted":
        this.outputTurnBuffer = "";
        this.sink.sendLive({ type: "interrupted" });
        break;
      case "turnComplete":
        if (this.inputTurnBuffer.trim().length > 0) {
          this.sink.noteHeard(this.inputTurnBuffer);
        }

        if (this.outputTurnBuffer.trim().length > 0) {
          this.sink.noteAssistantReply(this.outputTurnBuffer);
        }

        this.inputTurnBuffer = "";
        this.outputTurnBuffer = "";
        this.sink.sendLive({ type: "turnComplete" });
        this.sink.emitSnapshot();

        if (this.endRequested) {
          this.apply({ type: "stop" });
          return;
        }

        this.armIdleTimer();
        break;
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => this.apply({ type: "stop" }), this.idleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.endFallbackTimer) {
      clearTimeout(this.endFallbackTimer);
      this.endFallbackTimer = null;
    }
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unexpected error.";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace @family-hub/electron run test -- src/main/assistant/liveController.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm --workspace @family-hub/electron run typecheck`
Expected: no errors.

```bash
git add apps/electron/src/main/assistant/liveController.ts apps/electron/src/main/assistant/liveController.test.ts
git commit -m "feat(assistant): LiveController wiring transcriber, machine, and Gemini session"
```

---

## Task 5: Wire LiveController into the main IPC

Replace the renderer-driven wake/live flow in `ipc.ts` with the controller. Mic frames now always arrive (continuous stream); the controller decides what to buffer/send. Remove `assistant:detectWake` and the old `startLive`/`endLive`/`handleLiveEvent` internals.

**Files:**
- Modify: `apps/electron/src/main/assistant/ipc.ts`

- [ ] **Step 1: Replace the imports and live-state block**

Replace lines 1–46 (from `import { ipcMain … }` through the live-state `let …` declarations) with:

```ts
import { ipcMain, type WebContents } from "electron";
import { processLinear16AudioChunk } from "./audioPipeline";
import { GeminiLiveSession } from "./liveSession";
import {
  LiveController,
  type LiveControllerSink,
  type LiveStateEvent,
} from "./liveController";
import {
  ParakeetSidecarTranscriber,
  resolveSidecarPython,
  resolveSidecarScript,
  type LocalTranscriber,
} from "./localTranscriber";
import { FileSpeakerProfileStore } from "./profileStore";
import { AssistantService, PlaceholderGeminiLive } from "./service";
import type { AssistantSnapshot } from "./types";
import {
  GeminiLiveTextAdapter,
  GoogleSpeechDiarizationAdapter,
} from "./vendorAdapters";

const assistantStateChannel = "assistant:state";
const liveStateChannel = "assistant:live";
const liveAudioChannel = "assistant:liveAudio";

export function registerAssistantIpc(userDataDirectory: string): void {
  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_API;
  const gemini = geminiApiKey
    ? new GeminiLiveTextAdapter({ apiKey: geminiApiKey })
    : new PlaceholderGeminiLive();
  const speech = readGoogleSpeechConfigured()
    ? new GoogleSpeechDiarizationAdapter()
    : null;
  const service = new AssistantService({
    gemini,
    profileStore: new FileSpeakerProfileStore(userDataDirectory),
  });

  // The single renderer we stream live state to. Set when the renderer starts
  // listening; the controller pushes mode/transcript/audio events at it.
  let liveSender: WebContents | null = null;

  function sendLive(event: LiveStateEvent): void {
    if (liveSender && !liveSender.isDestroyed()) {
      liveSender.send(liveStateChannel, event);
    }
  }

  const sink: LiveControllerSink = {
    sendLive,
    sendLiveAudio: (chunk) => {
      if (liveSender && !liveSender.isDestroyed()) {
        liveSender.send(liveAudioChannel, chunk);
      }
    },
    noteHeard: (text) => service.noteHeard(text),
    noteAssistantReply: (text) => service.noteAssistantReply(text),
    noteInfo: (message) => service.noteInfo(message),
    emitSnapshot: () => {
      if (liveSender) {
        void emitSnapshot(liveSender, service);
      }
    },
  };

  const sidecarPython = resolveSidecarPython();
  const sidecarScript = resolveSidecarScript();
  const controller =
    geminiApiKey && sidecarPython && sidecarScript
      ? new LiveController({
          createTranscriber: (): LocalTranscriber =>
            new ParakeetSidecarTranscriber(sidecarPython, sidecarScript),
          createSession: () => new GeminiLiveSession({ apiKey: geminiApiKey }),
          sink,
        })
      : null;
```

- [ ] **Step 2: Delete the old live-session functions**

Delete the entire block of helper functions that previously lived inside `registerAssistantIpc`: `sendLive` (the old `WebContents`-arg version), `armIdleTimer`, `handleLiveEvent`, `startLive`, and `endLive` (originally lines ~48–216). They are now provided by `LiveController`. (The new `sendLive` from Step 1 replaces the old one.)

- [ ] **Step 3: Replace the IPC handlers block**

Replace the `// ----- IPC handlers -----` section through the end of `registerAssistantIpc` (originally lines ~218–343) with:

```ts
  // ----- IPC handlers -----
  ipcMain.handle("assistant:getSnapshot", async () => service.getSnapshot());

  ipcMain.handle("assistant:enrollSpeaker", async (event, name: unknown) => {
    const speaker = await service.enrollSpeaker(requireString(name, "Speaker name"));
    await emitSnapshot(event.sender, service);
    return speaker;
  });

  ipcMain.handle(
    "assistant:setSpeakerAllowed",
    async (event, speakerId: unknown, allowed: unknown) => {
      const speaker = await service.setSpeakerAllowed(
        requireString(speakerId, "Speaker id"),
        requireBoolean(allowed, "Allowed"),
      );
      await emitSnapshot(event.sender, service);
      return speaker;
    },
  );

  ipcMain.handle("assistant:deleteSpeaker", async (event, speakerId: unknown) => {
    const deleted = await service.deleteSpeaker(requireString(speakerId, "Speaker id"));
    await emitSnapshot(event.sender, service);
    return deleted;
  });

  ipcMain.handle("assistant:startListening", async (event) => {
    liveSender = event.sender;

    if (controller) {
      await controller.start();
    } else {
      service.noteInfo(
        "Local listener unavailable — set up the Parakeet sidecar (see sidecar/README.md).",
      );
    }

    const snapshot = await service.startListening();
    event.sender.send(assistantStateChannel, snapshot);
    return snapshot;
  });

  ipcMain.handle("assistant:stopListening", async (event) => {
    await controller?.stop();
    const snapshot = await service.stopListening();
    event.sender.send(assistantStateChannel, snapshot);
    return snapshot;
  });

  ipcMain.handle(
    "assistant:lockSessionSpeaker",
    async (event, speakerId: unknown, speakerLabel: unknown) => {
      const snapshot = await service.lockSessionSpeaker(
        requireString(speakerId, "Speaker id"),
        requireString(speakerLabel, "Speaker label"),
      );
      event.sender.send(assistantStateChannel, snapshot);
      return snapshot;
    },
  );

  ipcMain.handle(
    "assistant:submitTranscript",
    async (event, transcript: unknown, speakerLabel: unknown) => {
      const result = await service.submitTranscriptTurn({
        speakerLabel: requireString(speakerLabel, "Speaker label"),
        transcript: requireString(transcript, "Transcript"),
      });
      await emitSnapshot(event.sender, service);
      return result;
    },
  );

  // Continuous microphone stream (base64 LINEAR16 @16 kHz). The controller feeds
  // every frame to the local listener and decides what to buffer/forward.
  ipcMain.on("assistant:micFrame", (event, frame: unknown) => {
    if (typeof frame === "string") {
      liveSender = event.sender;
      controller?.handleFrame(frame);
    }
  });

  ipcMain.handle("assistant:endLive", async () => {
    await controller?.endLive();
    return true;
  });

  // Retained for the diagnostics panel / manual chunk submission.
  ipcMain.handle(
    "assistant:submitAudioChunk",
    async (event, audio: unknown, sampleRateHertz: unknown) => {
      if (!speech) {
        throw new Error("Google Speech is not configured.");
      }

      const result = await processLinear16AudioChunk({
        audio: requireUint8Array(audio, "Audio"),
        sampleRateHertz: requirePositiveNumber(sampleRateHertz, "Sample rate hertz"),
        service,
        speech,
      });
      await emitSnapshot(event.sender, service);
      return result;
    },
  );
}
```

- [ ] **Step 4: Remove now-dead imports and helpers**

`detectWake` is no longer referenced (it was only used by the deleted `assistant:detectWake` handler). Confirm the import line now reads `import { processLinear16AudioChunk } from "./audioPipeline";` (done in Step 1) and that `LiveEvent`/`endConversationToolName` are no longer imported here (they moved to the controller).

Also delete the now-unused `readErrorMessage` helper at the bottom of `ipc.ts` (it was only used by the deleted `startLive`/`endLive`). The remaining bottom-of-file helpers — `emitSnapshot`, `requireString`, `requireBoolean`, `requirePositiveNumber`, `requireUint8Array`, `readGoogleSpeechConfigured` — are all still referenced and must stay.

- [ ] **Step 5: Typecheck, run the full suite, and commit**

Run: `npm --workspace @family-hub/electron run typecheck`
Expected: no errors (no unused imports, no missing references).

Run: `npm --workspace @family-hub/electron run test`
Expected: all tests PASS (existing + new).

```bash
git add apps/electron/src/main/assistant/ipc.ts
git commit -m "feat(assistant): drive live sessions from LiveController; continuous mic stream"
```

---

## Task 6: Config probe + types for the local listener

Surface "Local listener (Parakeet)" readiness in the snapshot config.

**Files:**
- Modify: `apps/electron/src/main/assistant/types.ts`
- Modify: `apps/electron/src/main/assistant/config.ts`
- Modify: `apps/electron/src/main/assistant/service.test.ts`

- [ ] **Step 1: Extend the config status type**

In `apps/electron/src/main/assistant/types.ts`, replace the `AssistantConfigStatus` interface (lines 40–43):

```ts
export interface AssistantConfigStatus {
  gemini: boolean;
  googleSpeech: boolean;
  localListener: boolean;
}
```

- [ ] **Step 2: Probe the sidecar in config (injectable for determinism)**

The probe touches the filesystem, so it must be injectable — otherwise the existing exact-match config test would flip depending on whether `sidecar/.venv` exists on the machine. Replace the body of `apps/electron/src/main/assistant/config.ts`:

```ts
import { resolveSidecarPython, resolveSidecarScript } from "./localTranscriber";
import type { AssistantConfigStatus } from "./types";

export function localListenerAvailable(): boolean {
  return resolveSidecarPython() !== null && resolveSidecarScript() !== null;
}

export function readAssistantConfigStatus(
  environment: NodeJS.ProcessEnv = process.env,
  isLocalListenerAvailable: () => boolean = localListenerAvailable,
): AssistantConfigStatus {
  return {
    gemini:
      hasValue(environment.GEMINI_API_KEY) ||
      hasValue(environment.GOOGLE_API_KEY) ||
      hasValue(environment.GOOGLE_API),
    googleSpeech:
      hasValue(environment.GOOGLE_APPLICATION_CREDENTIALS) ||
      hasValue(environment.GOOGLE_CLOUD_PROJECT),
    localListener: isLocalListenerAvailable(),
  };
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
```

- [ ] **Step 3: Update the config assertions in `service.test.ts`**

In `apps/electron/src/main/assistant/service.test.ts`, replace the two exact-match assertions in the `"reports Gemini and Google Speech provider configuration"` test (lines 45–56) so they include `localListener` and inject a deterministic probe:

```ts
    expect(readAssistantConfigStatus(process.env, () => false)).toEqual({
      gemini: false,
      googleSpeech: false,
      localListener: false,
    });

    process.env.GEMINI_API_KEY = "gemini";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/google.json";

    expect(readAssistantConfigStatus(process.env, () => true)).toEqual({
      gemini: true,
      googleSpeech: true,
      localListener: true,
    });
```

(The `"accepts GOOGLE_API as a Gemini API key alias"` test at line 62 reads only `.gemini`, and the `getSnapshot()` tests use `toMatchObject`, so neither needs changes.)

- [ ] **Step 4: Typecheck, run tests, and commit**

Run: `npm --workspace @family-hub/electron run typecheck`
Expected: no errors.

Run: `npm --workspace @family-hub/electron run test -- src/main/assistant/service.test.ts`
Expected: PASS.

```bash
git add apps/electron/src/main/assistant/types.ts apps/electron/src/main/assistant/config.ts apps/electron/src/main/assistant/service.test.ts
git commit -m "feat(assistant): probe local Parakeet listener in config status"
```

---

## Task 7: Preload bridge + renderer types

Rename `sendLiveFrame`→`sendMicFrame` (continuous semantics), drop `detectWake`, and add `localListener` to the renderer config type.

**Files:**
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/src/vite-env.d.ts`

- [ ] **Step 1: Update the preload bridge**

In `apps/electron/src/preload/index.ts`, delete the `detectWake` property (lines 64–69) and replace `sendLiveFrame` (lines 70–72) with:

```ts
    sendMicFrame: (frame: string) => {
      ipcRenderer.send("assistant:micFrame", frame);
    },
```

- [ ] **Step 2: Update the renderer type declarations**

In `apps/electron/src/renderer/src/vite-env.d.ts`:

Replace `AssistantConfigStatus` (lines 3–6):

```ts
interface AssistantConfigStatus {
  gemini: boolean;
  googleSpeech: boolean;
  localListener: boolean;
}
```

In `interface AssistantBridge`, delete the `detectWake` member (lines 90–93) and replace `sendLiveFrame` (line 94):

```ts
  sendMicFrame: (frame: string) => void;
```

- [ ] **Step 3: Typecheck and commit**

Run: `npm --workspace @family-hub/electron run typecheck`
Expected: no errors. (`App.tsx` still references the old names — fixed in Task 8; if typecheck runs the web project it will flag them. That is expected and resolved next.)

```bash
git add apps/electron/src/preload/index.ts apps/electron/src/renderer/src/vite-env.d.ts
git commit -m "refactor(assistant): continuous mic bridge (sendMicFrame), drop detectWake"
```

---

## Task 8: Renderer — continuous streaming + UI

Stream every mic frame unconditionally (no wake-chunk path, no mode-based buffer clearing), show the local-listener provider row, and reflect the connecting status.

**Files:**
- Modify: `apps/electron/src/renderer/src/App.tsx`

- [ ] **Step 1: Replace the mic loop with continuous streaming**

In `apps/electron/src/renderer/src/App.tsx`, replace `startMicrophoneLoop` (lines 357–465) with a version that always streams and no longer takes `getMode`:

```ts
async function startMicrophoneLoop({
  onLevel,
  onError,
  onReady,
}: {
  onError: (message: string) => void;
  onLevel: (level: number) => void;
  onReady: (sampleRate: number) => void;
}): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    onError("Microphone unavailable");
    return () => {};
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const AudioContextConstructor =
      window.AudioContext ?? window.webkitAudioContext;
    const audioContext = new AudioContextConstructor({
      sampleRate: captureSampleRate,
    });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const mutedOutput = audioContext.createGain();
    let pendingSamples: number[] = [];
    let smoothedLevel = 0;

    mutedOutput.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);

      for (const sample of channel) {
        pendingSamples.push(sample);
      }

      const currentLevel = calculateMicrophoneLevel(channel);
      smoothedLevel = Math.round(smoothedLevel * 0.72 + currentLevel * 0.28);
      onLevel(smoothedLevel);
    };

    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(audioContext.destination);

    // The main process is always listening (local Parakeet) and decides what to
    // buffer/forward, so the renderer streams every frame unconditionally.
    const intervalId = window.setInterval(() => {
      if (pendingSamples.length === 0) {
        return;
      }

      const samples = pendingSamples;
      pendingSamples = [];
      const pcm = convertFloatSamplesToLinear16(samples);
      window.familyHub.assistant.sendMicFrame(int16ToBase64(pcm));
    }, 120);

    onReady(audioContext.sampleRate);

    return () => {
      window.clearInterval(intervalId);
      processor.disconnect();
      mutedOutput.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    };
  } catch (error) {
    onError(`Microphone blocked: ${readErrorMessage(error)}`);
    return () => {};
  }
}
```

- [ ] **Step 2: Remove the now-unused wake-chunk constant and mode plumbing in the mic effect**

Delete the `wakeChunkSamples` constant (line 22). Update the mic-start effect (lines 111–132) to drop `getMode`:

```ts
  useEffect(() => {
    if (micStartedRef.current) {
      return;
    }

    micStartedRef.current = true;
    const cleanup = startMicrophoneLoop({
      onError: (message) => {
        setMicLevel(0);
        setMicStatus(message);
      },
      onLevel: setMicLevel,
      onReady: (sampleRate) => {
        setMicStatus(`Microphone live (${Math.round(sampleRate)} Hz)`);
      },
    });

    return () => {
      void cleanup.then((stop) => stop());
    };
  }, []);
```

`liveModeRef` is still updated in the `onLive` "mode" handler and still drives the UI (`liveMode`), so leave `liveModeRef` and the `onLive` handler as-is.

- [ ] **Step 3: Update the provider row and count**

Replace the empty-config default (lines 4–7) to include the new field:

```ts
  config: {
    gemini: false,
    googleSpeech: false,
    localListener: false,
  },
```

Replace the provider rows (lines 213–220) so the wake-word provider reflects the local listener:

```tsx
          <ProviderRow
            configured={snapshot.config.localListener}
            name="Local listener (Parakeet)"
          />
          <ProviderRow
            configured={snapshot.config.gemini}
            name="Gemini Live (conversation)"
          />
```

Update the provider count to reflect two relevant providers (Google Speech is now diagnostics-only). Replace lines 134–136:

```ts
  const configuredProviderCount = [
    snapshot.config.localListener,
    snapshot.config.gemini,
  ].filter(Boolean).length;
```

- [ ] **Step 4: Typecheck, lint, and commit**

Run: `npm --workspace @family-hub/electron run typecheck`
Expected: no errors.

Run: `npm --workspace @family-hub/electron run lint`
Expected: no errors/warnings.

```bash
git add apps/electron/src/renderer/src/App.tsx
git commit -m "feat(renderer): stream mic continuously; show local listener provider"
```

---

## Task 9: Packaging, docs, and end-to-end verification

Bundle the sidecar into the packaged app (mac) and verify the whole flow against the real services.

**Files:**
- Modify: `apps/electron/package.json`
- Modify: `README.md`

- [ ] **Step 1: Ship the sidecar as a packaged resource**

In `apps/electron/package.json`, add `extraResources` to the `build` block (after `"files"`):

```json
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
```

> Note: this copies the script but not the `.venv`. For a fully self-contained distributable, a follow-up should freeze the sidecar with PyInstaller and ship the binary; for the owner's own machine, `resolveSidecarPython()` finds the dev `sidecar/.venv`.

- [ ] **Step 2: Document the sidecar in the README**

Add a "Voice assistant" section to `README.md`:

```markdown
## Voice assistant (James)

The assistant uses an always-on local ASR sidecar (Parakeet, Apple Silicon) for
the "James" wake word and to capture speech while the Gemini Live session
connects. Set it up once:

```bash
cd sidecar
./setup.sh
```

Required environment (in `.env.local` or `~/.familyhub/.env`):

- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — Gemini Live conversation.

Google Cloud Speech credentials are now optional (diagnostics only).
```

- [ ] **Step 3: Full build verification**

Run: `npm run build`
Expected: typecheck + build succeed across the workspace.

Run: `npm run test`
Expected: all tests PASS.

- [ ] **Step 4: Manual end-to-end check (the real goal)**

Pre-req: `sidecar/setup.sh` has been run, `GEMINI_API_KEY` is set, mic permission granted.

```bash
npm run dev
```

Verify, in order:
1. Providers panel shows **Local listener (Parakeet): Ready** and **Gemini Live: Ready**.
2. Console/app shows the sidecar ready signal (no Python tracebacks).
3. Say **"James, what's the weather like today?"** in one continuous breath, **without pausing** after "James".
4. The status briefly shows **"Connecting…"** then **"Live — go ahead and talk."**
5. The assistant's reply addresses the *full* question (weather), proving the words spoken during connect were captured and replayed — **not** just a generic greeting.
6. Say a follow-up; confirm normal live conversation.
7. Say "thanks, that's all" / "goodbye"; confirm the session ends and returns to waiting for "James".
8. Say "James …" again; confirm a previous utterance does **not** re-trigger instantly (the transcriber reset worked) and a fresh capture happens.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/package.json README.md
git commit -m "chore: package Parakeet sidecar; document voice assistant setup"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** local listener (Tasks 2–3), audio replay across connect (Tasks 1, 4, 5), exactly-once seam (Task 1), renderer-goes-dumb (Task 8), Google off the hot path (Task 5 keeps `submitAudioChunk` only), mac-only packaging (Task 9), local-listener UI (Tasks 6–8). All covered.
- **Type consistency:** `LiveStateEvent`/`LiveControllerSink`/`LiveSessionLike` are defined in `liveController.ts` (Task 4) and imported in `ipc.ts` (Task 5). `sendMicFrame` and `assistant:micFrame` are used consistently across preload (Task 7), ipc (Task 5), and renderer (Task 8). `AssistantConfigStatus.localListener` is added in main (Task 6) and renderer (Task 7) together.
- **Out of scope (do not implement):** fully removing Google Speech / diarization, speaker-identity gating on the live path, precise wake-word trimming, Windows/Linux, PyInstaller freezing.
```
