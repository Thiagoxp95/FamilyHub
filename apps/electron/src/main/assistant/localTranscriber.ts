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
