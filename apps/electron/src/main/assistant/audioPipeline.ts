import { transcriptContainsWakePhrase } from "./gating";
import { groupDiarizedWordsIntoTurns } from "./turns";
import type { AssistantService, TranscriptTurnResult } from "./service";
import type { DiarizedWord } from "./types";

export interface SpeechDiarizationAdapter {
  recognizeLinear16(
    audio: Uint8Array,
    sampleRateHertz: number,
  ): Promise<DiarizedWord[]>;
}

interface DetectWakeWordInput {
  audio: Uint8Array;
  sampleRateHertz: number;
  speech: SpeechDiarizationAdapter;
  wakePhrases: string[];
}

// Transcribes a microphone chunk only to decide whether the wake phrase was
// spoken. Used while idle; once woken, audio streams to Gemini Live instead.
export async function detectWakeWord({
  audio,
  sampleRateHertz,
  speech,
  wakePhrases,
}: DetectWakeWordInput): Promise<{ transcript: string; woke: boolean }> {
  if (audio.byteLength === 0) {
    return { transcript: "", woke: false };
  }

  const words = await speech.recognizeLinear16(audio, sampleRateHertz);
  const transcript = words
    .map((word) => word.word)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    transcript,
    woke: transcriptContainsWakePhrase(transcript, wakePhrases),
  };
}

interface ProcessLinear16AudioChunkInput {
  audio: Uint8Array;
  sampleRateHertz: number;
  service: AssistantService;
  speech: SpeechDiarizationAdapter;
}

export async function processLinear16AudioChunk({
  audio,
  sampleRateHertz,
  service,
  speech,
}: ProcessLinear16AudioChunkInput): Promise<TranscriptTurnResult[]> {
  if (audio.byteLength === 0) {
    return [];
  }

  const words = await speech.recognizeLinear16(audio, sampleRateHertz);
  const turns = groupDiarizedWordsIntoTurns(words);
  const results: TranscriptTurnResult[] = [];

  for (const turn of turns) {
    results.push(
      await service.submitTranscriptTurn({
        speakerLabel: turn.speakerLabel,
        transcript: turn.transcript,
      }),
    );
  }

  return results;
}
