import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSpeechDiarizationAdapter } from "./vendorAdapters";

const speechMocks = vi.hoisted(() => {
  const recognize = vi.fn();
  const SpeechClient = vi.fn(function SpeechClient() {
    return {
      recognize,
    };
  });

  return {
    recognize,
    SpeechClient,
  };
});

vi.mock("@google-cloud/speech", () => ({
  v1: {
    SpeechClient: speechMocks.SpeechClient,
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(),
  Modality: {
    TEXT: "TEXT",
  },
}));

describe("GoogleSpeechDiarizationAdapter", () => {
  beforeEach(() => {
    speechMocks.recognize.mockReset();
    speechMocks.SpeechClient.mockClear();
    speechMocks.recognize.mockResolvedValue([
      {
        results: [
          {
            alternatives: [
              {
                words: [
                  {
                    endTime: { nanos: 200_000_000 },
                    speakerTag: 1,
                    startTime: { nanos: 0 },
                    word: "James",
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("requests v1 synchronous speaker diarization with word offsets", async () => {
    const adapter = new GoogleSpeechDiarizationAdapter();

    const words = await adapter.recognizeLinear16(
      new Uint8Array([1, 2, 3, 4]),
      48_000,
    );

    expect(speechMocks.recognize).toHaveBeenCalledOnce();
    expect(speechMocks.recognize.mock.calls[0]?.[0].config).toMatchObject({
      diarizationConfig: {
        enableSpeakerDiarization: true,
        maxSpeakerCount: 6,
        minSpeakerCount: 1,
      },
      enableWordTimeOffsets: true,
      encoding: "LINEAR16",
      sampleRateHertz: 48_000,
    });
    expect(words).toEqual([
      { endOffsetMs: 200, speakerLabel: "1", startOffsetMs: 0, word: "James" },
    ]);
  });
});
