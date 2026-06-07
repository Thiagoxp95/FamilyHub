import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// Wraps the speaker_gate.py sidecar. During a live session the controller streams
// every mic frame in; the gate VAD-segments, enrolls the first utterance as the
// locked speaker, and emits "forward" only for utterances matching that speaker —
// so only the invoker's voice (not the TV/YouTube/others) reaches Gemini.

export interface SpeakerGateDecision {
  type: "enrolled" | "forward" | "dropped";
  score?: number | undefined;
}

export interface SpeakerGateHandlers {
  // An approved utterance (base64 int16 PCM @16 kHz) to send on to Gemini.
  onForward: (audioBase64: string) => void;
  onDecision?: (decision: SpeakerGateDecision) => void;
  onError?: (message: string) => void;
}

export interface SpeakerGateLike {
  start(handlers: SpeakerGateHandlers): Promise<void>;
  feed(frame: string): void;
  reset(): void;
  stop(): Promise<void>;
}

export class SpeakerGate implements SpeakerGateLike {
  private process: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly pythonPath: string,
    private readonly scriptPath: string,
  ) {}

  async start(handlers: SpeakerGateHandlers): Promise<void> {
    if (this.process) {
      return;
    }

    const child = spawn(this.pythonPath, [this.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }

      const record = parsed as Record<string, unknown>;
      const type = record.type;
      const score = typeof record.score === "number" ? record.score : undefined;

      if (type === "forward" && typeof record.audio === "string") {
        handlers.onForward(record.audio);
        handlers.onDecision?.({ type: "forward", score });
      } else if (type === "dropped") {
        handlers.onDecision?.({ type: "dropped", score });
      } else if (type === "enrolled") {
        handlers.onDecision?.({ type: "enrolled" });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      handlers.onError?.(chunk.toString().trim());
    });

    child.on("error", (error) => {
      handlers.onError?.(error.message);
    });

    child.on("exit", () => {
      this.process = null;
    });
  }

  feed(frame: string): void {
    this.process?.stdin.write(`${frame}\n`);
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
