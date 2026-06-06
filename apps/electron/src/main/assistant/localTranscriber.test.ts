import { describe, expect, it } from "vitest";
import { parseTranscriptLine } from "./localTranscriber";

describe("parseTranscriptLine", () => {
  it("parses a partial transcript with words", () => {
    expect(
      parseTranscriptLine(
        '{"type":"partial","text":"james turn on","words":[{"word":"james","startMs":0,"endMs":200}]}',
      ),
    ).toEqual({
      type: "partial",
      text: "james turn on",
      words: [{ word: "james", startMs: 0, endMs: 200 }],
    });
  });

  it("parses a final transcript and defaults missing words to []", () => {
    expect(parseTranscriptLine('{"type":"final","text":"hello"}')).toEqual({
      type: "final",
      text: "hello",
      words: [],
    });
  });

  it("defaults a missing text to an empty string", () => {
    expect(parseTranscriptLine('{"type":"partial"}')).toEqual({
      type: "partial",
      text: "",
      words: [],
    });
  });

  it("drops malformed word entries", () => {
    expect(
      parseTranscriptLine(
        '{"type":"partial","text":"x","words":[{"word":"x","startMs":1,"endMs":2},{"nope":true}]}',
      ),
    ).toEqual({
      type: "partial",
      text: "x",
      words: [{ word: "x", startMs: 1, endMs: 2 }],
    });
  });

  it("returns null for blank lines, invalid JSON, and unknown types", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine("   ")).toBeNull();
    expect(parseTranscriptLine("not json")).toBeNull();
    expect(parseTranscriptLine("[1,2,3]")).toBeNull();
    expect(parseTranscriptLine('{"type":"weird","text":"x"}')).toBeNull();
  });
});
