// Common ASR mis-spellings of wake phrase tokens, so a slightly misheard
// assistant name still wakes. Keep this curated rather than edit-distance so
// ordinary words ("names", "jameson") don't trigger.
const wakeWordAliases: Record<string, readonly string[]> = {
  james: ["jaymes", "jaimes", "jamez", "jaymz", "hames", "jaymez"],
};

function tokenMatchesWord(token: string, word: string): boolean {
  if (token === word) {
    return true;
  }

  return wakeWordAliases[word]?.includes(token) ?? false;
}

// Wake check for the live-audio trigger: does the normalized transcript contain
// a complete wake phrase as a contiguous token run?
export function transcriptContainsWakePhrase(
  transcript: string,
  wakePhrases: string[],
): boolean {
  const normalized = normalizeTranscript(transcript);

  if (normalized.length === 0) {
    return false;
  }

  const tokens = normalized.split(" ");

  return wakePhrases.some((phrase) => {
    const words = normalizeTranscript(phrase).split(" ").filter(Boolean);
    const [firstWord] = words;

    if (firstWord === undefined) {
      return false;
    }

    return tokenWindowMatches(tokens, words);
  });
}

function tokenWindowMatches(tokens: string[], words: string[]): boolean {
  if (words.length === 0 || words.length > tokens.length) {
    return false;
  }

  for (let start = 0; start <= tokens.length - words.length; start += 1) {
    const windowMatches = words.every((word, offset) => {
      const token = tokens[start + offset];
      return token !== undefined && tokenMatchesWord(token, word);
    });

    if (windowMatches) {
      return true;
    }
  }

  return false;
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

  return endCommands.some(
    (command) => normalized === normalizeTranscript(command),
  );
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
