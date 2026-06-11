import { describe, expect, it, vi } from "vitest";
import {
  LiveController,
  type LiveControllerSink,
  type LiveSessionLike,
} from "./liveController";
import type { LiveSessionHandlers } from "./liveSession";
import type {
  LocalTranscriber,
  LocalTranscriberHandlers,
} from "./localTranscriber";

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
  toolResponses: Array<{ id: string; name: string }> = [];
  closed = false;

  async start(handlers: LiveSessionHandlers): Promise<void> {
    this.handlers = handlers;
  }

  sendAudioFrame(frame: string): void {
    this.sentFrames.push(frame);
  }

  sendToolResponse(id: string, name: string): void {
    this.toolResponses.push({ id, name });
  }

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
  it("streams only post-open audio to the session (no pre-roll/connect replay)", async () => {
    const { controller, transcriber, sessions, sink } = await setup();

    controller.handleFrame("p1"); // before wake — must NOT be replayed
    controller.handleFrame("p2");
    transcriber.emit("hey james turn on the lights"); // wake → connect → open

    // Wait until the session is actually open (mode flips to "live").
    await vi.waitFor(() =>
      expect(sink.live).toContainEqual({ type: "mode", mode: "live" }),
    );

    controller.handleFrame("l1"); // live — streamed
    controller.handleFrame("l2");

    expect(sessions[0]?.sentFrames).toEqual(["l1", "l2"]);
  });

  it("acknowledges the wake with connecting mode before the session opens", async () => {
    const { transcriber, sink } = await setup();

    transcriber.emit("hey james hello");

    // "connecting" must be emitted synchronously on wake — it's the user's
    // immediate feedback — while "live" only lands after the async connect.
    expect(sink.live).toContainEqual({ type: "mode", mode: "connecting" });
    expect(sink.live).not.toContainEqual({ type: "mode", mode: "live" });

    await vi.waitFor(() =>
      expect(sink.live).toContainEqual({ type: "mode", mode: "live" }),
    );

    const modes = sink.live
      .filter(
        (event): event is { type: "mode"; mode: string } =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: string }).type === "mode",
      )
      .map((event) => event.mode);
    expect(modes.indexOf("connecting")).toBeLessThan(modes.indexOf("live"));
  });

  it("feeds every frame to the transcriber and resets it on start", async () => {
    const { controller, transcriber } = await setup();
    expect(transcriber.resets).toBe(1); // reset on start

    controller.handleFrame("a");
    controller.handleFrame("b");

    expect(transcriber.writes).toEqual(["a", "b"]);
  });

  it("ignores a second wake while a session is active", async () => {
    const { transcriber, sessions } = await setup();

    transcriber.emit("hey james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    transcriber.emit("hey james again");
    await new Promise((r) => setTimeout(r, 10));

    expect(sessions).toHaveLength(1);
  });

  it("does not wake on the assistant name without the full wake phrase", async () => {
    const { transcriber, sessions } = await setup();

    transcriber.emit("james hello");
    await new Promise((r) => setTimeout(r, 10));

    expect(sessions).toHaveLength(0);
  });

  it("closes the session on stop and returns to wake mode", async () => {
    const { controller, transcriber, sessions, sink } = await setup();

    transcriber.emit("hey james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    await controller.endLive();
    await vi.waitFor(() => expect(sessions[0]?.closed).toBe(true));

    expect(sink.live).toContainEqual({ type: "mode", mode: "wake" });
  });

  it("reports the end reason on the status channel when stopped", async () => {
    const { controller, transcriber, sessions, sink } = await setup();

    transcriber.emit("hey james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    await controller.endLive();
    await vi.waitFor(() => expect(sessions[0]?.closed).toBe(true));

    expect(sink.live).toContainEqual({
      type: "status",
      message: "Session ended (stopped).",
    });
  });

  it("does not time out while a slow tool runs, re-arming idle only after it responds", async () => {
    const transcriber = new FakeTranscriber();
    const sessions: FakeSession[] = [];
    const sink = createSink();
    let releaseTool: () => void = () => {};
    const runTool = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      return { ok: true };
    });
    const controller = new LiveController({
      createTranscriber: () => transcriber,
      createSession: () => {
        const session = new FakeSession();
        sessions.push(session);
        return session;
      },
      runTool,
      sink,
      idleTimeoutMs: 120,
    });
    await controller.start();

    transcriber.emit("hey james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0];

    session?.handlers?.onEvent({
      kind: "toolCall",
      id: "t1",
      name: "list_reminders",
      args: {},
    });
    await vi.waitFor(() => expect(runTool).toHaveBeenCalledTimes(1));

    // Tool still running well past the idle timeout — must NOT close the session.
    await new Promise((r) => setTimeout(r, 200));
    expect(session?.closed).toBe(false);

    // Once the tool responds, the idle countdown resumes and eventually fires.
    releaseTool();
    await vi.waitFor(() => expect(session?.toolResponses).toHaveLength(1));
    await vi.waitFor(() => expect(session?.closed).toBe(true));
  });

  it("does not time out while the assistant is mid-reply (output/audio re-arm idle)", async () => {
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
      idleTimeoutMs: 120,
    });
    await controller.start();

    transcriber.emit("hey james tell me a long story");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0];

    // User finished; the model now speaks for far longer than the idle timeout,
    // streaming transcript + audio the whole time. These MUST keep the session
    // alive — the assistant talking is activity, not silence.
    session?.handlers?.onEvent({ kind: "inputTranscript", text: "..." });
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 40)); // 240ms total ≫ 120ms timeout
      session?.handlers?.onEvent({ kind: "outputTranscript", text: "and then" });
      session?.handlers?.onEvent({
        kind: "audio",
        data: "AAAA",
        mimeType: "audio/pcm;rate=24000",
      });
    }
    expect(session?.closed).toBe(false);

    // Once the assistant stops talking, the idle countdown runs out and closes.
    await vi.waitFor(() => expect(session?.closed).toBe(true));
  });

  it("keeps the session alive while a slow computer task runs even if a sibling tool finishes first", async () => {
    const transcriber = new FakeTranscriber();
    const sessions: FakeSession[] = [];
    const sink = createSink();
    let releaseComputer: () => void = () => {};
    const runTool = vi.fn(async (name: string) => {
      if (name === "run_computer_task") {
        await new Promise<void>((resolve) => {
          releaseComputer = resolve;
        });
      }
      return { ok: true };
    });
    const controller = new LiveController({
      createTranscriber: () => transcriber,
      createSession: () => {
        const session = new FakeSession();
        sessions.push(session);
        return session;
      },
      runTool,
      sink,
      idleTimeoutMs: 120,
    });
    await controller.start();

    transcriber.emit("hey james open safari");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0];

    // Gemini fires the long computer task AND a quick sibling in the same turn.
    session?.handlers?.onEvent({
      kind: "toolCall",
      id: "c1",
      name: "run_computer_task",
      args: { task: "open Safari" },
    });
    session?.handlers?.onEvent({
      kind: "toolCall",
      id: "r1",
      name: "list_reminders",
      args: {},
    });

    // The quick sibling resolves immediately; it MUST NOT re-arm the idle timer
    // and kill the still-running computer task.
    await new Promise((r) => setTimeout(r, 200));
    expect(session?.closed).toBe(false);

    // Once the computer task finishes, the idle countdown resumes and closes.
    releaseComputer();
    await vi.waitFor(() => expect(session?.closed).toBe(true));
  });

  it("suppresses a reflexive tile zoom while a computer task is in flight", async () => {
    const transcriber = new FakeTranscriber();
    const sessions: FakeSession[] = [];
    const sink = createSink();
    let releaseComputer: () => void = () => {};
    const runTool = vi.fn(async (name: string) => {
      if (name === "run_computer_task") {
        await new Promise<void>((resolve) => {
          releaseComputer = resolve;
        });
      }
      return { ok: true };
    });
    const controller = new LiveController({
      createTranscriber: () => transcriber,
      createSession: () => {
        const session = new FakeSession();
        sessions.push(session);
        return session;
      },
      runTool,
      sink,
      idleTimeoutMs: 5_000,
    });
    await controller.start();

    transcriber.emit("hey james open safari");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0];

    session?.handlers?.onEvent({
      kind: "toolCall",
      id: "c1",
      name: "run_computer_task",
      args: { task: "open Safari" },
    });
    session?.handlers?.onEvent({
      kind: "toolCall",
      id: "z1",
      name: "show_calendar_card",
      args: {},
    });

    await vi.waitFor(() => expect(runTool).toHaveBeenCalled());
    // The zoom must be dropped — runTool is invoked for the computer task only,
    // never for the show_*_card — but Gemini still gets a response for it.
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith("run_computer_task", {
      task: "open Safari",
    });
    expect(session?.toolResponses.map((r) => r.name)).toContain(
      "show_calendar_card",
    );

    releaseComputer();
  });

  it("resets dashboard focus when the session ends (collapses full-screen quadrants)", async () => {
    const transcriber = new FakeTranscriber();
    const sessions: FakeSession[] = [];
    const sink = createSink();
    const resetDashboardFocus = vi.fn();
    const controller = new LiveController({
      createTranscriber: () => transcriber,
      createSession: () => {
        const session = new FakeSession();
        sessions.push(session);
        return session;
      },
      resetDashboardFocus,
      sink,
    });
    await controller.start();

    transcriber.emit("hey james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    await controller.endLive();
    await vi.waitFor(() =>
      expect(resetDashboardFocus).toHaveBeenCalledTimes(1),
    );
  });
});
