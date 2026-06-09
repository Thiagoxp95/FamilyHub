import { describe, expect, it } from "vitest";
import { transcriptContainsWakePhrase } from "./gating";

describe("transcriptContainsWakePhrase", () => {
  it("matches the wake phrase anywhere in the transcript", () => {
    expect(
      transcriptContainsWakePhrase("hey James how are you", ["hey james"]),
    ).toBe(true);
    expect(transcriptContainsWakePhrase("okay hey James", ["hey james"])).toBe(
      true,
    );
  });

  it("is case- and punctuation-insensitive", () => {
    expect(transcriptContainsWakePhrase("HEY, JAMES!", ["hey james"])).toBe(
      true,
    );
  });

  it("does not match the assistant name without the wake phrase", () => {
    expect(transcriptContainsWakePhrase("james", ["hey james"])).toBe(false);
    expect(transcriptContainsWakePhrase("okay James", ["hey james"])).toBe(
      false,
    );
  });

  it("does not match substrings of other words", () => {
    expect(transcriptContainsWakePhrase("hey jameson", ["hey james"])).toBe(
      false,
    );
    expect(transcriptContainsWakePhrase("they james", ["hey james"])).toBe(
      false,
    );
  });

  it("matches curated mis-spellings of the assistant name in the wake phrase", () => {
    expect(
      transcriptContainsWakePhrase("hey hames are you there", ["hey james"]),
    ).toBe(true);
    expect(transcriptContainsWakePhrase("hey Jaymes?", ["hey james"])).toBe(
      true,
    );
  });

  it("does not match unrelated similar words", () => {
    expect(
      transcriptContainsWakePhrase("hey what are their names", ["hey james"]),
    ).toBe(false);
    expect(transcriptContainsWakePhrase("hey play a game", ["hey james"])).toBe(
      false,
    );
  });

  it("returns false for empty transcripts", () => {
    expect(transcriptContainsWakePhrase("", ["hey james"])).toBe(false);
  });
});
