import type { DiarizedTurn, DiarizedWord } from "./types";

interface GroupDiarizedWordsOptions {
  maxSilenceGapMs?: number;
}

const defaultMaxSilenceGapMs = 1_200;

export function groupDiarizedWordsIntoTurns(
  words: DiarizedWord[],
  options: GroupDiarizedWordsOptions = {},
): DiarizedTurn[] {
  const maxSilenceGapMs = options.maxSilenceGapMs ?? defaultMaxSilenceGapMs;
  const sortedWords = words
    .filter((word) => word.word.trim().length > 0)
    .toSorted((left, right) => left.startOffsetMs - right.startOffsetMs);
  const turns: DiarizedTurn[] = [];

  for (const currentWord of sortedWords) {
    const previousTurn = turns.at(-1);
    const silenceGapMs = previousTurn
      ? currentWord.startOffsetMs - previousTurn.endOffsetMs
      : 0;
    const shouldStartNewTurn =
      !previousTurn ||
      previousTurn.speakerLabel !== currentWord.speakerLabel ||
      silenceGapMs > maxSilenceGapMs;

    if (shouldStartNewTurn) {
      turns.push({
        endOffsetMs: currentWord.endOffsetMs,
        speakerLabel: currentWord.speakerLabel,
        startOffsetMs: currentWord.startOffsetMs,
        transcript: currentWord.word.trim(),
        words: [currentWord],
      });
      continue;
    }

    previousTurn.endOffsetMs = currentWord.endOffsetMs;
    previousTurn.transcript = `${previousTurn.transcript} ${currentWord.word.trim()}`;
    previousTurn.words.push(currentWord);
  }

  return turns;
}
