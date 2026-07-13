import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeminiLiveSession,
  interpretLiveMessage,
  type LiveEvent,
} from "./liveSession";
import type { LiveServerMessage } from "@google/genai";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    return { live: { connect: connectMock } };
  }),
  EndSensitivity: { END_SENSITIVITY_HIGH: "END_SENSITIVITY_HIGH" },
  Modality: { AUDIO: "AUDIO" },
  Type: {
    ARRAY: "ARRAY",
    BOOLEAN: "BOOLEAN",
    NUMBER: "NUMBER",
    OBJECT: "OBJECT",
    STRING: "STRING",
  },
}));

function interpret(message: unknown): LiveEvent[] {
  return interpretLiveMessage(message as LiveServerMessage);
}

// start() now resolves only after the server's `setupComplete`. connect() itself
// just opens the socket, so the mock must deliver setupComplete via onmessage or
// start() would hang. Returns the fake session for assertions.
function mockConnectReady(): {
  close: ReturnType<typeof vi.fn>;
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
} {
  const session = {
    close: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
  connectMock.mockImplementationOnce(
    (params: { callbacks: { onmessage: (message: unknown) => void } }) => {
      queueMicrotask(() => params.callbacks.onmessage({ setupComplete: {} }));
      return Promise.resolve(session);
    },
  );
  return session;
}

describe("interpretLiveMessage", () => {
  it("returns nothing when there is no server content", () => {
    expect(interpret({})).toEqual([]);
  });

  it("extracts input and output transcripts", () => {
    expect(
      interpret({
        serverContent: {
          inputTranscription: { text: "hello there" },
          outputTranscription: { text: "hi back" },
        },
      }),
    ).toEqual([
      { kind: "inputTranscript", text: "hello there" },
      { kind: "outputTranscript", text: "hi back" },
    ]);
  });

  it("extracts audio parts with a default mime type", () => {
    expect(
      interpret({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } },
              { text: "ignored" },
              { inlineData: { data: "BBBB" } },
            ],
          },
        },
      }),
    ).toEqual([
      { kind: "audio", data: "AAAA", mimeType: "audio/pcm;rate=24000" },
      { kind: "audio", data: "BBBB", mimeType: "audio/pcm;rate=24000" },
    ]);
  });

  it("flags interruptions and turn completion", () => {
    expect(
      interpret({ serverContent: { interrupted: true, turnComplete: true } }),
    ).toEqual([{ kind: "interrupted" }, { kind: "turnComplete" }]);
  });

  it("extracts tool calls with their arguments", () => {
    expect(
      interpret({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: "end_conversation",
              args: { reason: "user said goodbye" },
            },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "toolCall",
        id: "call-1",
        name: "end_conversation",
        args: { reason: "user said goodbye" },
      },
    ]);
  });

  it("defaults missing tool-call id and args", () => {
    expect(
      interpret({ toolCall: { functionCalls: [{ name: "end_conversation" }] } }),
    ).toEqual([
      { kind: "toolCall", id: "", name: "end_conversation", args: {} },
    ]);
  });
});

describe("GeminiLiveSession", () => {
  // connectMock accumulates calls across tests; clear so calls[0] is always the
  // connect made by the test currently running.
  beforeEach(() => {
    connectMock.mockClear();
  });

  it("tells the model James is the assistant identity, not a family member", async () => {
    mockConnectReady();

    await new GeminiLiveSession({ apiKey: "test-key" }).start({
      onClosed: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
    });

    const connectConfig = connectMock.mock.calls[0]?.[0];
    const instruction =
      connectConfig?.config?.systemInstruction?.parts?.[0]?.text;

    expect(instruction).toContain(
      "James is your assistant name, not a family member or calendar owner.",
    );
  });

  it("tells the model to end silently with no spoken farewell", async () => {
    mockConnectReady();

    await new GeminiLiveSession({ apiKey: "test-key" }).start({
      onClosed: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
    });

    const connectConfig = connectMock.mock.calls[0]?.[0];
    const instruction =
      connectConfig?.config?.systemInstruction?.parts?.[0]?.text;

    expect(instruction).toContain("no spoken farewell");
  });

  it("tells the model to manage notes and zoom the active dashboard quadrant", async () => {
    mockConnectReady();

    await new GeminiLiveSession({ apiKey: "test-key" }).start({
      onClosed: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
    });

    const connectConfig = connectMock.mock.calls[0]?.[0];
    const instruction =
      connectConfig?.config?.systemInstruction?.parts?.[0]?.text;

    expect(instruction).toContain("family Calendar, Reminders, and Notes");
    expect(instruction).toContain("show_notes_card");
    expect(instruction).toContain("show_weather_card");
  });

  it("configures high end-of-speech sensitivity so replies start sooner", async () => {
    mockConnectReady();

    await new GeminiLiveSession({ apiKey: "test-key" }).start({
      onClosed: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
    });

    const connectConfig = connectMock.mock.calls[0]?.[0];
    const detection =
      connectConfig?.config?.realtimeInputConfig?.automaticActivityDetection;

    expect(detection?.endOfSpeechSensitivity).toBe("END_SENSITIVITY_HIGH");
  });

  it("registers note CRUD tools and quadrant focus tools", async () => {
    mockConnectReady();

    await new GeminiLiveSession({ apiKey: "test-key" }).start({
      onClosed: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
    });

    const connectConfig = connectMock.mock.calls[0]?.[0];
    // Tools is a heterogeneous list (e.g. { googleSearch: {} } alongside our
    // { functionDeclarations: [...] }), so find the entry by content rather than
    // index — adding a built-in tool must not shift this assertion.
    const declarations =
      connectConfig?.config?.tools?.find(
        (tool: { functionDeclarations?: unknown[] }) => tool.functionDeclarations,
      )?.functionDeclarations ?? [];
    const names = declarations.map((tool: { name?: string }) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "get_notes",
        "create_note",
        "update_note",
        "delete_note",
        "get_weather",
        "show_calendar_card",
        "hide_calendar_card",
        "show_weather_card",
        "hide_weather_card",
        "show_reminders_card",
        "hide_reminders_card",
        "show_notes_card",
        "hide_notes_card",
      ]),
    );

    const createNote = declarations.find(
      (tool: { name?: string }) => tool.name === "create_note",
    );
    expect(createNote?.parameters?.required).toEqual(["text", "emoji"]);
  });
});
