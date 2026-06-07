import { describe, expect, it, vi } from "vitest";
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
  Modality: { AUDIO: "AUDIO" },
  Type: { OBJECT: "OBJECT", STRING: "STRING" },
}));

function interpret(message: unknown): LiveEvent[] {
  return interpretLiveMessage(message as LiveServerMessage);
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
  it("tells the model James is the assistant identity, not a family member", async () => {
    connectMock.mockResolvedValueOnce({
      close: vi.fn(),
      sendRealtimeInput: vi.fn(),
      sendToolResponse: vi.fn(),
    });

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
});
