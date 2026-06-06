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

  // Gemini live events: buffer transcripts, pass audio through, handle the
  // end_conversation tool and turn completion. Mirrors the prior ipc.ts logic.
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
