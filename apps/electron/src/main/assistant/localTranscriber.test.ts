import { describe, expect, it } from "vitest";
import { parseTranscriptLine, parseUtteranceLine } from "./localTranscriber";

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

  it("returns null for utterance lines (reserved for parseUtteranceLine)", () => {
    expect(parseTranscriptLine(JSON.stringify({
      type: "utterance", text: "jonas party is saturday", t0: 100.5, t1: 103.2, engine: "parakeet",
    }))).toBeNull();
  });
});

describe("parseUtteranceLine", () => {
  it("parses a well-formed utterance line", () => {
    const line = JSON.stringify({
      type: "utterance", text: "jonas party is saturday", t0: 100.5, t1: 103.2, engine: "parakeet",
    });
    expect(parseUtteranceLine(line)).toEqual({
      type: "utterance", text: "jonas party is saturday", t0: 100.5, t1: 103.2, engine: "parakeet",
    });
  });

  it("rejects wake transcript lines", () => {
    expect(parseUtteranceLine(JSON.stringify({ type: "final", text: "hey james", words: [] }))).toBeNull();
  });

  it("rejects garbage and missing fields", () => {
    expect(parseUtteranceLine("not json")).toBeNull();
    expect(parseUtteranceLine(JSON.stringify({ type: "utterance", text: 5 }))).toBeNull();
    expect(parseUtteranceLine(JSON.stringify({ type: "utterance", text: "x", t0: "a", t1: 2, engine: "e" }))).toBeNull();
  });
});
