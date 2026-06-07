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
  it("streams only post-open audio to the session (no pre-roll/connect replay)", async () => {
    const { controller, transcriber, sessions, sink } = await setup();

    controller.handleFrame("p1"); // before wake — must NOT be replayed
    controller.handleFrame("p2");
    transcriber.emit("james turn on the lights"); // wake → connect → open

    // Wait until the session is actually open (mode flips to "live").
    await vi.waitFor(() =>
      expect(sink.live).toContainEqual({ type: "mode", mode: "live" }),
    );

    controller.handleFrame("l1"); // live — streamed
    controller.handleFrame("l2");

    expect(sessions[0]?.sentFrames).toEqual(["l1", "l2"]);
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
    await vi.waitFor(() => expect(sessions[0]?.closed).toBe(true));

    expect(sink.live).toContainEqual({ type: "mode", mode: "wake" });
  });

  it("reports the end reason on the status channel when stopped", async () => {
    const { controller, transcriber, sessions, sink } = await setup();

    transcriber.emit("james hello");
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    await controller.endLive();
    await vi.waitFor(() => expect(sessions[0]?.closed).toBe(true));

    expect(sink.live).toContainEqual({
      type: "status",
      message: "Session ended (stopped).",
    });
  });
});
