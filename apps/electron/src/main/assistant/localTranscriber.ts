import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

  // Prefer the self-contained runtime bundled into packaged builds
  // (scripts/build-sidecar-runtime.sh) over a dev-only .venv, so an installed
  // app never depends on a system Python that a fresh machine won't have.
  const roots = sidecarRoots();
  return firstExisting([
    ...roots.map((root) => resolve(root, ".runtime/bin/python3")),
    ...roots.map((root) => resolve(root, ".venv/bin/python")),
  ]);
}

export function resolveSidecarScript(): string | null {
  if (process.env.FAMILYHUB_SIDECAR_SCRIPT) {
    return process.env.FAMILYHUB_SIDECAR_SCRIPT;
  }

  return firstExisting(
    sidecarRoots().map((root) => resolve(root, "wake_listener.py")),
  );
}

function sidecarRoots(): string[] {
  const roots = [
    resolve(process.cwd(), "sidecar"),
    resolve(process.cwd(), "../../sidecar"),
  ];

  // process.cwd() is unreliable for an Electron app (Finder-launched apps run
  // with cwd "/"), so also resolve relative to this module's location, which is
  // stable across dev and launch context.
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    for (const up of ["..", "../..", "../../..", "../../../..", "../../../../.."]) {
      roots.push(resolve(moduleDir, up, "sidecar"));
    }
  } catch {
    // import.meta.url unavailable (e.g. an unexpected bundling target) — ignore.
  }

  if (process.resourcesPath) {
    roots.push(resolve(process.resourcesPath, "sidecar"));
  }

  return roots;
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

// Long-lived wake-word sidecar (Vosk keyword spotter). Communicates over stdio:
// base64 audio lines in, JSON transcript lines out. A line beginning with "{" on
// stdin is a control command (base64 never starts with "{"). It emits a
// transcript containing a wake word only when one is confidently spotted.
export class WakeWordSidecar implements LocalTranscriber {
  private process: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly pythonPath: string,
    private readonly scriptPath: string,
  ) {}

  async start(handlers: LocalTranscriberHandlers): Promise<void> {
    if (this.process) {
      return;
    }

    const child = spawn(this.pythonPath, [this.scriptPath], {
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
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolveStop();
      });
      child.stdin.end();
      child.kill("SIGTERM");
    });
  }
}
