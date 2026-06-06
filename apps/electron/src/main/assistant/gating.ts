import type { SessionSpeakerGateDecision } from "./types";

interface EvaluateWakeSessionTurnInput {
  lockedSpeakerLabel: string | null;
  transcript: string;
  turnSpeakerLabel: string;
  wakePhrases: string[];
}

export function evaluateWakeSessionTurn({
  lockedSpeakerLabel,
  transcript,
  turnSpeakerLabel,
  wakePhrases,
}: EvaluateWakeSessionTurnInput): SessionSpeakerGateDecision {
  if (lockedSpeakerLabel && lockedSpeakerLabel !== turnSpeakerLabel) {
    return {
      accepted: false,
      reason: "speaker_label_mismatch",
      sessionStarted: false,
    };
  }

  if (lockedSpeakerLabel) {
    return {
      accepted: true,
      prompt: stripWakePhrase(transcript, wakePhrases),
      reason: "accepted",
      sessionStarted: false,
    };
  }

  const command = extractWakeCommand(transcript, wakePhrases);

  if (!command.woke) {
    return {
      accepted: false,
      reason: "wake_phrase_missing",
      sessionStarted: false,
    };
  }

  if (command.prompt.length === 0) {
    return {
      accepted: false,
      reason: "wake_command_missing",
      sessionStarted: true,
    };
  }

  return {
    accepted: true,
    prompt: command.prompt,
    reason: "accepted",
    sessionStarted: true,
  };
}

// Lenient wake check for the live-audio trigger: does the (arbitrarily chunked)
// transcript contain a wake phrase anywhere? A false positive only opens a live
// session that closes itself on silence, so erring toward sensitivity is fine.
export function transcriptContainsWakePhrase(
  transcript: string,
  wakePhrases: string[],
): boolean {
  const normalized = normalizeTranscript(transcript);

  if (normalized.length === 0) {
    return false;
  }

  const tokens = new Set(normalized.split(" "));

  return wakePhrases.some((phrase) => {
    const words = normalizeTranscript(phrase).split(" ").filter(Boolean);
    const [firstWord] = words;

    if (firstWord === undefined) {
      return false;
    }

    if (words.length === 1) {
      return tokens.has(firstWord);
    }

    return normalized.includes(words.join(" "));
  });
}

export function isSessionEndCommand(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  const endCommands = [
    "cancel",
    "never mind",
    "stop",
    "stop listening",
    "thanks",
    "thanks familyhub",
    "thank you",
    "thank you familyhub",
    "thats all",
    "that's all",
  ];

  return endCommands.some((command) => normalized === normalizeTranscript(command));
}

function extractWakeCommand(
  transcript: string,
  wakePhrases: string[],
): { prompt: string; woke: boolean } {
  const matchedPhrase = wakePhrases
    .map((phrase) => createWakePhrasePattern(phrase).exec(transcript))
    .find((match) => match !== null);

  if (!matchedPhrase) {
    return {
      prompt: "",
      woke: false,
    };
  }

  return {
    prompt: transcript
      .slice(matchedPhrase[0].length)
      .replace(/^[\s,.:;!?-]+/, "")
      .trim(),
    woke: true,
  };
}

function stripWakePhrase(transcript: string, wakePhrases: string[]): string {
  const command = extractWakeCommand(transcript, wakePhrases);
  return command.woke ? command.prompt : transcript;
}

function normalizeTranscript(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createWakePhrasePattern(phrase: string): RegExp {
  const words = normalizeTranscript(phrase).split(" ").filter(Boolean);
  const source = words.map(escapeRegExp).join("[^a-z0-9]+");
  return new RegExp(`^\\s*${source}(?:\\b|$)`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
