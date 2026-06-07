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
  | { type: "listener"; state: "loading" | "ready" | "offline"; detail?: string }
  | { type: "localHeard"; text: string; phase: string }
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

// Runs a non-end_conversation tool call and returns the result object sent back
// to Gemini. Injected so the controller stays free of Calendar/Reminders logic.
export type ToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface LiveControllerOptions {
  createTranscriber: () => LocalTranscriber;
  createSession: () => LiveSessionLike;
  sink: LiveControllerSink;
  runTool?: ToolRunner;
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
  private readonly runTool: ToolRunner | null;
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
  private pendingReason: string | null = null;
  private listenerReady = false;

  constructor(options: LiveControllerOptions) {
    this.createTranscriber = options.createTranscriber;
    this.createSession = options.createSession;
    this.sink = options.sink;
    this.runTool = options.runTool ?? null;
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
    this.listenerReady = false;

    await transcriber.start({
      onTranscript: (message) => {
        // The first line the sidecar emits is its ready signal (model loaded).
        if (!this.listenerReady) {
          this.listenerReady = true;
          this.sink.sendLive({ type: "listener", state: "ready" });
        }

        this.handleTranscript(message.text);
      },
      onError: (message) => {
        if (this.listenerReady) {
          this.sink.noteInfo(`Listener error: ${message}`);
        } else {
          // Pre-ready stderr is model download/load progress; surface it so the
          // UI shows movement instead of an opaque wait (first run is ~600 MB).
          this.sink.sendLive({ type: "listener", state: "loading", detail: message });
        }
      },
      onExit: () => {
        this.listenerReady = false;
        this.sink.sendLive({ type: "listener", state: "offline" });
        this.sink.noteInfo("Listener stopped.");
      },
    });

    this.sink.sendLive({ type: "listener", state: "loading" });
    transcriber.reset();
  }

  handleFrame(frame: string): void {
    // Only run wake detection while idle. During connecting/live/closing the
    // mic is destined for Gemini, so feeding the local ASR there just wastes
    // compute and competes with the live audio path.
    if (this.state.phase === "idle") {
      this.transcriber?.write(frame);
    }

    this.apply({ type: "frame", frame });
  }

  async endLive(): Promise<void> {
    this.pendingReason = "stopped";
    this.apply({ type: "stop" });
  }

  async stop(): Promise<void> {
    this.pendingReason = "stopped";
    this.apply({ type: "stop" });
    const transcriber = this.transcriber;
    this.transcriber = null;
    await transcriber?.stop();
  }

  private handleTranscript(text: string): void {
    const trimmed = text.trim();

    // Diagnostic: surface every transcript + the current phase so the wake path
    // is observable (is the listener still hearing after a session ends?).
    if (trimmed.length > 0) {
      this.sink.sendLive({ type: "localHeard", text: trimmed, phase: this.state.phase });
    }

    if (this.state.phase !== "idle") {
      return;
    }

    if (transcriptContainsWakePhrase(text, this.wakePhrases)) {
      this.sink.noteInfo(`Wake detected: "${trimmed}"`);
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
    this.pendingReason = null;
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
    this.endRequested = false;

    const effectiveReason = this.pendingReason ?? reason;
    this.pendingReason = null;

    if (this.state.phase !== "idle") {
      this.apply({ type: "sessionClosed" });
    }

    this.transcriber?.reset();
    this.sink.noteInfo(`Live session ended (${effectiveReason}).`);
    this.sink.sendLive({
      type: "status",
      message: `Session ended (${effectiveReason}).`,
    });
    this.sink.sendLive({ type: "mode", mode: "wake" });
    this.sink.emitSnapshot();
  }

  // Gemini live events: buffer transcripts, pass audio through, handle the
  // end_conversation tool and turn completion. Mirrors the prior ipc.ts logic.
  private handleLiveEvent(event: LiveEvent): void {
    if (this.finalized) {
      return;
    }

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

          this.endFallbackTimer = setTimeout(() => {
            this.pendingReason = this.endReason;
            this.apply({ type: "stop" });
          }, 5_000);
        } else {
          // Calendar/Reminders tool — run it and return the result to Gemini.
          this.armIdleTimer();
          void this.runToolCall(event.id, event.name, event.args);
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
          this.pendingReason = this.endReason;
          this.apply({ type: "stop" });
          return;
        }

        this.armIdleTimer();
        break;
    }
  }

  private async runToolCall(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (!this.runTool) {
      this.session?.sendToolResponse(id, name, {
        ok: false,
        error: "Tool is not available.",
      });
      return;
    }

    let result: Record<string, unknown>;
    try {
      result = await this.runTool(name, args);
    } catch (error) {
      result = { ok: false, error: readErrorMessage(error) };
    }

    // The session may have ended while the tool ran.
    this.session?.sendToolResponse(id, name, result);
    this.sink.emitSnapshot();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.pendingReason = "timed out";
      this.apply({ type: "stop" });
    }, this.idleTimeoutMs);
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
