import { describe, expect, it } from "vitest";
import { groupDiarizedWordsIntoTurns } from "./turns";
import type { DiarizedWord } from "./types";

function word(
  text: string,
  speakerLabel: string,
  startOffsetMs: number,
  endOffsetMs: number,
): DiarizedWord {
  return {
    endOffsetMs,
    speakerLabel,
    startOffsetMs,
    word: text,
  };
}

describe("groupDiarizedWordsIntoTurns", () => {
  it("groups adjacent words from the same speaker into one turn", () => {
    const turns = groupDiarizedWordsIntoTurns([
      word("turn", "1", 0, 100),
      word("on", "1", 120, 200),
      word("lights", "1", 240, 360),
    ]);

    expect(turns).toEqual([
      {
        endOffsetMs: 360,
        speakerLabel: "1",
        startOffsetMs: 0,
        transcript: "turn on lights",
        words: [
          word("turn", "1", 0, 100),
          word("on", "1", 120, 200),
          word("lights", "1", 240, 360),
        ],
      },
    ]);
  });

  it("starts a new turn when the speaker label changes", () => {
    const turns = groupDiarizedWordsIntoTurns([
      word("hello", "1", 0, 150),
      word("there", "1", 170, 240),
      word("stop", "2", 260, 350),
    ]);

    expect(turns.map((turn) => turn.transcript)).toEqual(["hello there", "stop"]);
    expect(turns.map((turn) => turn.speakerLabel)).toEqual(["1", "2"]);
  });

  it("starts a new turn after a long silence gap", () => {
    const turns = groupDiarizedWordsIntoTurns(
      [word("hello", "1", 0, 100), word("again", "1", 1_800, 1_950)],
      { maxSilenceGapMs: 1_000 },
    );

    expect(turns.map((turn) => turn.transcript)).toEqual(["hello", "again"]);
  });

  it("ignores blank words and sorts by start offset", () => {
    const turns = groupDiarizedWordsIntoTurns([
      word("second", "1", 300, 400),
      word("", "1", 100, 120),
      word("first", "1", 0, 90),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.transcript).toBe("first second");
  });
});
