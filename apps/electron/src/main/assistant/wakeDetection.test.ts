import { describe, expect, it, vi } from "vitest";
import { detectWakeWord } from "./audioPipeline";
import { transcriptContainsWakePhrase } from "./gating";
import type { DiarizedWord } from "./types";

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(),
  Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
}));

describe("transcriptContainsWakePhrase", () => {
  it("matches the wake word anywhere in the transcript", () => {
    expect(transcriptContainsWakePhrase("hey James how are you", ["james"])).toBe(
      true,
    );
    expect(transcriptContainsWakePhrase("okay James", ["james"])).toBe(true);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(transcriptContainsWakePhrase("JAMES!", ["james"])).toBe(true);
  });

  it("does not match substrings of other words", () => {
    expect(transcriptContainsWakePhrase("jameson coffee", ["james"])).toBe(false);
  });

  it("matches curated mis-spellings of the wake word", () => {
    expect(transcriptContainsWakePhrase("hames are you there", ["james"])).toBe(
      true,
    );
    expect(transcriptContainsWakePhrase("Jaymes?", ["james"])).toBe(true);
  });

  it("does not match unrelated similar words", () => {
    expect(transcriptContainsWakePhrase("what are their names", ["james"])).toBe(
      false,
    );
    expect(transcriptContainsWakePhrase("play a game", ["james"])).toBe(false);
  });

  it("returns false for empty transcripts", () => {
    expect(transcriptContainsWakePhrase("", ["james"])).toBe(false);
  });
});

describe("detectWakeWord", () => {
  function speechReturning(words: DiarizedWord[]) {
    return { recognizeLinear16: vi.fn().mockResolvedValue(words) };
  }

  it("returns woke=true when the transcript contains the wake phrase", async () => {
    const speech = speechReturning([
      word("hey"),
      word("James"),
      word("hello"),
    ]);

    const result = await detectWakeWord({
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHertz: 16000,
      speech,
      wakePhrases: ["james"],
    });

    expect(result).toEqual({ transcript: "hey James hello", woke: true });
  });

  it("returns woke=false when the wake phrase is absent", async () => {
    const speech = speechReturning([word("turn"), word("on"), word("lights")]);

    const result = await detectWakeWord({
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHertz: 16000,
      speech,
      wakePhrases: ["james"],
    });

    expect(result.woke).toBe(false);
  });

  it("short-circuits on empty audio without calling speech", async () => {
    const speech = speechReturning([]);

    const result = await detectWakeWord({
      audio: new Uint8Array(),
      sampleRateHertz: 16000,
      speech,
      wakePhrases: ["james"],
    });

    expect(result).toEqual({ transcript: "", woke: false });
    expect(speech.recognizeLinear16).not.toHaveBeenCalled();
  });
});

function word(text: string): DiarizedWord {
  return { endOffsetMs: 0, speakerLabel: "1", startOffsetMs: 0, word: text };
}
