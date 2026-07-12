import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import {
  computerToolName,
  dashboardToolNames,
  endConversationToolName,
  type LiveEvent,
  type LiveSessionHandlers,
} from "./liveSession";
import type { AmbientUtterance, LocalTranscriber } from "./localTranscriber";

// The "zoom a quadrant to full screen" tool calls. While a computer-control task
// owns the screen, Gemini sometimes reflexively fires one of these (usually
// show_calendar_card) in the same turn; we drop them so the dashboard stays put.
const dashboardShowToolNames = new Set<string>([
  dashboardToolNames.showCalendar,
  dashboardToolNames.showWeather,
  dashboardToolNames.showReminders,
  dashboardToolNames.showNotes,
]);

// The subset of GeminiLiveSession the controller depends on (so tests can fake
// it without a websocket).
export interface LiveSessionLike {
  start(handlers: LiveSessionHandlers): Promise<void>;
  sendAudioFrame(frame: string): void;
  sendToolResponse(
    id: string,
    name: string,
    response: Record<string, unknown>,
  ): void;
  close(): Promise<void>;
}

export type LiveStateEvent =
  | { type: "mode"; mode: "wake" | "connecting" | "live" }
  | { type: "inputTranscript"; text: string }
  | { type: "outputTranscript"; text: string }
  | { type: "status"; message: string }
  | {
      type: "listener";
      state: "loading" | "ready" | "offline";
      detail?: string;
    }
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
  // Called whenever a session ends, so any full-screen dashboard quadrant the
  // assistant (or user) opened collapses back to the grid.
  resetDashboardFocus?: () => void;
  wakePhrases?: string[];
  config?: ListenerConfig;
  idleTimeoutMs?: number;
  // Forwarded from the transcriber's onUtterance handler — every sidecar-
  // detected utterance (idle-time ambient speech), not just wake-triggered
  // sessions. Feeds the ambient memory pipeline in ipc.ts.
  onAmbientUtterance?: (utterance: AmbientUtterance) => void;
}

const defaultWakePhrases = ["hey james"];
// Silence (no user speech, no assistant audio, no running tool) before the
// session closes itself. Re-armed on every input/output/audio event, so this
// only counts genuine quiet — long replies and think-time mid-conversation are
// fine. 30s gives someone room to pause and gather a thought at the counter.
const defaultIdleTimeoutMs = 30_000;

// Diagnostic trace for the wake → gate → Gemini path. Prints to the main-process
// console AND appends to ~/.familyhub/live-debug.log, so a packaged build launched
// via `open` (no attached terminal) is still observable. Set FAMILYHUB_DEBUG=0 to
// silence.
const debugLogPath = join(homedir(), ".familyhub", "live-debug.log");
let debugLogDirReady = false;

function debug(message: string): void {
  if (process.env.FAMILYHUB_DEBUG === "0") {
    return;
  }

  const line = `${new Date().toISOString()} [live] ${message}`;
  console.error(line);

  // Skip the file write under tests so the suite doesn't touch the real home dir.
  if (process.env.VITEST) {
    return;
  }

  try {
    if (!debugLogDirReady) {
      mkdirSync(dirname(debugLogPath), { recursive: true });
      debugLogDirReady = true;
    }
    appendFileSync(debugLogPath, `${line}\n`);
  } catch {
    // Best effort — never let logging break the live path.
  }
}

export class LiveController {
  private readonly createTranscriber: () => LocalTranscriber;
  private readonly createSession: () => LiveSessionLike;
  private readonly sink: LiveControllerSink;
  private readonly runTool: ToolRunner | null;
  private readonly resetDashboardFocus: (() => void) | null;
  private readonly wakePhrases: string[];
  private readonly config: ListenerConfig;
  private readonly idleTimeoutMs: number;
  private readonly onAmbientUtterance:
    | ((utterance: AmbientUtterance) => void)
    | null;

  private transcriber: LocalTranscriber | null = null;
  private session: LiveSessionLike | null = null;
  private state: ListenerState = createListenerState();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Tool calls still running. The idle countdown only re-arms once this hits 0,
  // so a quick tool finishing can't kill the session while a slow one (e.g. a
  // 180s computer task) is still in flight.
  private inFlightToolCount = 0;
  // Computer-control tasks specifically in flight — while > 0 we suppress tile
  // zoom tool calls so "open an app" doesn't full-screen the calendar quadrant.
  private computerTasksInFlight = 0;
  private finalized = true;
  private inputTurnBuffer = "";
  private outputTurnBuffer = "";
  private pendingReason: string | null = null;
  private listenerReady = false;

  constructor(options: LiveControllerOptions) {
    this.createTranscriber = options.createTranscriber;
    this.createSession = options.createSession;
    this.sink = options.sink;
    this.runTool = options.runTool ?? null;
    this.resetDashboardFocus = options.resetDashboardFocus ?? null;
    this.wakePhrases = options.wakePhrases ?? defaultWakePhrases;
    this.config = options.config ?? defaultListenerConfig;
    this.idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs;
    this.onAmbientUtterance = options.onAmbientUtterance ?? null;
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
      onUtterance: (utterance) => this.onAmbientUtterance?.(utterance),
      onError: (message) => {
        if (this.listenerReady) {
          this.sink.noteInfo(`Listener error: ${message}`);
        } else {
          // Pre-ready stderr is model download/load progress; surface it so the
          // UI shows movement instead of an opaque wait (first run is ~600 MB).
          this.sink.sendLive({
            type: "listener",
            state: "loading",
            detail: message,
          });
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
    // Only run local wake detection while idle. Once a session is connecting or
    // live, every frame streams straight to Gemini, which owns turn-taking and
    // interruption with its own server-side VAD. There is no local middleman
    // analysing the audio to decide whether to let the user interrupt — Gemini
    // handles barge-in natively (emitting an `interrupted` event).
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
      this.sink.sendLive({
        type: "localHeard",
        text: trimmed,
        phase: this.state.phase,
      });
    }

    if (this.state.phase !== "idle") {
      // Mid-session the local listener is inert: Gemini owns turn-taking and
      // interruption. The wake phrase only ever starts a session from idle — it
      // is never a mid-session interrupt trigger.
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
    this.pendingReason = null;
    this.inFlightToolCount = 0;
    this.computerTasksInFlight = 0;
    this.inputTurnBuffer = "";
    this.outputTurnBuffer = "";
    // Acknowledge the wake IMMEDIATELY, before the Gemini connect (median
    // ~400 ms, tail 1.4–2.5 s). The renderer shows the voice strip on
    // "connecting", so the user sees the wake land the moment it fires instead
    // of staring at a silent dashboard until the websocket opens.
    this.sink.sendLive({ type: "mode", mode: "connecting" });
    this.sink.sendLive({ type: "status", message: "Connecting…" });

    debug("connecting to Gemini Live…");
    try {
      await session.start({
        onEvent: (event) => this.handleLiveEvent(event),
        onClosed: (reason) => {
          debug(`gemini closed: ${reason}`);
          this.finalize(reason);
        },
        onError: (message) => {
          debug(`gemini error: ${message}`);
          this.sink.sendLive({ type: "status", message });
        },
      });
    } catch (error) {
      debug(`connect failed: ${readErrorMessage(error)}`);
      this.finalize(`could not connect: ${readErrorMessage(error)}`);
      return;
    }

    debug("session open — streaming live audio");
    this.apply({ type: "sessionOpen" });
    this.sink.noteInfo("Wake word heard — live session started.");
    this.sink.sendLive({ type: "mode", mode: "live" });
    this.sink.sendLive({
      type: "status",
      message: "Live — go ahead and talk.",
    });
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

    const effectiveReason = this.pendingReason ?? reason;
    this.pendingReason = null;

    if (this.state.phase !== "idle") {
      this.apply({ type: "sessionClosed" });
    }

    this.transcriber?.reset();
    // Collapse any full-screen quadrant the session opened, back to the grid.
    this.resetDashboardFocus?.();
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

    // Trace what Gemini sends back. A healthy turn shows: inputTranscript →
    // outputTranscript/audio → turnComplete. Seeing only inputTranscript (never
    // output or turnComplete) means the turn boundary never registered.
    debug(
      `← ${event.kind}${
        event.kind === "inputTranscript" || event.kind === "outputTranscript"
          ? `: "${event.text}"`
          : event.kind === "toolCall"
            ? `: ${event.name}`
            : ""
      }`,
    );

    switch (event.kind) {
      case "inputTranscript":
        this.inputTurnBuffer += event.text;
        this.armIdleTimer();
        this.sink.sendLive({
          type: "inputTranscript",
          text: this.inputTurnBuffer,
        });
        break;
      case "outputTranscript":
        // The assistant talking is activity, not silence: a long reply must not
        // trip the idle timeout and kill the session mid-sentence. Re-arm on every
        // output chunk so the countdown only runs once James actually goes quiet.
        this.armIdleTimer();
        this.outputTurnBuffer += event.text;
        this.sink.sendLive({
          type: "outputTranscript",
          text: this.outputTurnBuffer,
        });
        break;
      case "audio":
        this.armIdleTimer();
        this.sink.sendLiveAudio({ data: event.data, mimeType: event.mimeType });
        break;
      case "toolCall":
        if (event.name === endConversationToolName) {
          this.session?.sendToolResponse(event.id, event.name, {
            status: "ended",
          });
          // James is instructed to give no spoken farewell, so there is no
          // audio left to play: tear down right away instead of waiting for
          // the (1–2 s later) turnComplete that would otherwise gate the close.
          this.pendingReason =
            typeof event.args.reason === "string" && event.args.reason.trim()
              ? event.args.reason.trim()
              : "said goodbye";
          this.apply({ type: "stop" });
          return;
        } else if (
          dashboardShowToolNames.has(event.name) &&
          this.computerTasksInFlight > 0
        ) {
          // A computer-control task owns the screen right now. Drop the reflexive
          // tile zoom (the user wants the dashboard left alone during computer
          // use), but still acknowledge it so Gemini's turn isn't left hanging.
          this.session?.sendToolResponse(event.id, event.name, { ok: true });
        } else {
          // Calendar/Reminders/computer tool — run it and return the result to
          // Gemini. Pause the idle timer while any tool runs: a slow AppleScript
          // (completing a reminder) or a 180s computer task is legitimate work,
          // not silence, and must not trip the timeout mid-call. runToolCall
          // re-arms the timer once every in-flight tool has responded.
          this.clearIdleTimer();
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

    // Count this tool as in flight (synchronously, before the first await) so a
    // sibling tool dispatched in the same turn sees it and doesn't re-arm the
    // idle timer out from under it.
    this.inFlightToolCount += 1;
    const isComputerTask = name === computerToolName;
    if (isComputerTask) {
      this.computerTasksInFlight += 1;
      // Collapse any quadrant a sibling show_*_card zoomed before this ran, so a
      // computer task always leaves the dashboard in its normal grid.
      this.resetDashboardFocus?.();
    }

    let result: Record<string, unknown>;
    try {
      result = await this.runTool(name, args);
    } catch (error) {
      result = { ok: false, error: readErrorMessage(error) };
    } finally {
      this.inFlightToolCount = Math.max(0, this.inFlightToolCount - 1);
      if (isComputerTask) {
        this.computerTasksInFlight = Math.max(0, this.computerTasksInFlight - 1);
      }
    }

    // Surface the tool call + outcome in the activity log for debugging.
    this.sink.noteInfo(`🛠 ${name}: ${summarizeToolResult(result)}`);

    // The session may have ended while the tool ran.
    this.session?.sendToolResponse(id, name, result);
    this.sink.emitSnapshot();

    // Resume the idle countdown only once every in-flight tool has responded, so
    // a quick tool can't kill the session while a slow one is still running.
    if (!this.finalized && this.inFlightToolCount === 0) {
      this.armIdleTimer();
    }
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

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
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

function summarizeToolResult(result: Record<string, unknown>): string {
  if (result.ok === false) {
    return `error: ${typeof result.error === "string" ? result.error : "unknown"}`;
  }
  if (Array.isArray(result.events)) {
    return `${result.events.length} event(s)`;
  }
  if (Array.isArray(result.reminders)) {
    return `${result.reminders.length} reminder(s)`;
  }
  return "ok";
}
