import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { processLinear16AudioChunk, type SpeechDiarizationAdapter } from "./audioPipeline";
import { FileSpeakerProfileStore } from "./profileStore";
import { AssistantService, type GeminiLiveAdapter } from "./service";
import type { DiarizedWord } from "./types";

class FakeGemini implements GeminiLiveAdapter {
  prompts: string[] = [];

  async sendVerifiedTurn(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return `response to ${prompt}`;
  }
}

class FakeSpeech implements SpeechDiarizationAdapter {
  constructor(private readonly words: DiarizedWord[]) {}

  async recognizeLinear16(): Promise<DiarizedWord[]> {
    return this.words;
  }
}

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

async function createService(): Promise<{
  gemini: FakeGemini;
  service: AssistantService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "family-hub-audio-"));
  const gemini = new FakeGemini();
  const service = new AssistantService({
    gemini,
    profileStore: new FileSpeakerProfileStore(directory),
  });
  await service.startListening();

  return { gemini, service };
}

describe("processLinear16AudioChunk", () => {
  it("forwards Google diarized turns through the wake gate", async () => {
    const { gemini, service } = await createService();
    const speech = new FakeSpeech([
      word("James", "1", 0, 200),
      word("turn", "1", 220, 300),
      word("on", "1", 320, 390),
      word("lights", "1", 410, 500),
    ]);

    const results = await processLinear16AudioChunk({
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHertz: 16_000,
      service,
      speech,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      accepted: true,
      assistantResponse: "response to turn on lights",
      speakerLabel: "1",
    });
    expect(gemini.prompts).toEqual(["turn on lights"]);
  });
});
