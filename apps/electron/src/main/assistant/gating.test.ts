import { describe, expect, it } from "vitest";
import { evaluateWakeSessionTurn, isSessionEndCommand } from "./gating";

const wakePhrases = ["james"];

describe("evaluateWakeSessionTurn", () => {
  it("starts a session and extracts a command from the wake phrase speaker", () => {
    expect(
      evaluateWakeSessionTurn({
        lockedSpeakerLabel: null,
        transcript: "James, turn on the kitchen lights",
        turnSpeakerLabel: "1",
        wakePhrases,
      }),
    ).toEqual({
      accepted: true,
      prompt: "turn on the kitchen lights",
      reason: "accepted",
      sessionStarted: true,
    });
  });

  it("opens a session without forwarding when only the wake phrase was heard", () => {
    expect(
      evaluateWakeSessionTurn({
        lockedSpeakerLabel: null,
        transcript: "James",
        turnSpeakerLabel: "1",
        wakePhrases,
      }),
    ).toEqual({
      accepted: false,
      reason: "wake_command_missing",
      sessionStarted: true,
    });
  });

  it("ignores ambient speech before a wake phrase", () => {
    expect(
      evaluateWakeSessionTurn({
        lockedSpeakerLabel: null,
        transcript: "turn on the kitchen lights",
        turnSpeakerLabel: "1",
        wakePhrases,
      }),
    ).toEqual({
      accepted: false,
      reason: "wake_phrase_missing",
      sessionStarted: false,
    });
  });

  it("accepts turns from the locked diarization speaker label", () => {
    expect(
      evaluateWakeSessionTurn({
        lockedSpeakerLabel: "1",
        transcript: "turn on the kitchen lights",
        turnSpeakerLabel: "1",
        wakePhrases,
      }),
    ).toEqual({
      accepted: true,
      prompt: "turn on the kitchen lights",
      reason: "accepted",
      sessionStarted: false,
    });
  });

  it("rejects turns from a different diarization speaker label", () => {
    expect(
      evaluateWakeSessionTurn({
        lockedSpeakerLabel: "1",
        transcript: "turn on the kitchen lights",
        turnSpeakerLabel: "2",
        wakePhrases,
      }),
    ).toEqual({
      accepted: false,
      reason: "speaker_label_mismatch",
      sessionStarted: false,
    });
  });
});

describe("isSessionEndCommand", () => {
  it("recognizes short commands that close the active session", () => {
    expect(isSessionEndCommand("never mind")).toBe(true);
    expect(isSessionEndCommand("thank you familyhub")).toBe(true);
    expect(isSessionEndCommand("turn on the lights")).toBe(false);
  });
});
