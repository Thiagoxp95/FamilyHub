import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { readAssistantConfigStatus } from "./config";
import { FileSpeakerProfileStore } from "./profileStore";
import { AssistantService, type GeminiLiveAdapter } from "./service";

class FakeGemini implements GeminiLiveAdapter {
  prompts: string[] = [];

  async sendVerifiedTurn(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return `response to ${prompt}`;
  }
}

async function createService(): Promise<{
  gemini: FakeGemini;
  service: AssistantService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "family-hub-service-"));
  const gemini = new FakeGemini();
  const service = new AssistantService({
    gemini,
    profileStore: new FileSpeakerProfileStore(directory),
  });

  return { gemini, service };
}

describe("readAssistantConfigStatus", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  it("reports Gemini and Google Speech provider configuration", () => {
    expect(readAssistantConfigStatus()).toEqual({
      gemini: false,
      googleSpeech: false,
    });

    process.env.GEMINI_API_KEY = "gemini";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/google.json";

    expect(readAssistantConfigStatus()).toEqual({
      gemini: true,
      googleSpeech: true,
    });
  });

  it("accepts GOOGLE_API as a Gemini API key alias", () => {
    process.env.GOOGLE_API = "gemini";

    expect(readAssistantConfigStatus().gemini).toBe(true);
  });
});

describe("AssistantService", () => {
  it("enrolls a speaker name without creating a persistent voiceprint", async () => {
    const { service } = await createService();

    const speaker = await service.enrollSpeaker("Max");

    expect(speaker.name).toBe("Max");
    await expect(service.listSpeakers()).resolves.toEqual([speaker]);
  });

  it("starts listening without enrolled speakers", async () => {
    const { service } = await createService();

    const snapshot = await service.startListening();

    expect(snapshot.isListening).toBe(true);
    expect(snapshot.wakePhrase).toBe("James");
  });

  it("locks an enrolled speaker to a session diarization label", async () => {
    const { service } = await createService();
    const speaker = await service.enrollSpeaker("Max");
    await service.startListening();

    const snapshot = await service.lockSessionSpeaker(speaker.id, "1");

    expect(snapshot.currentSpeakerName).toBe("Max");
    expect(snapshot.lockedSpeakerLabel).toBe("1");
  });

  it("starts a session from the wake phrase and forwards the command text", async () => {
    const { gemini, service } = await createService();
    await service.startListening();

    const result = await service.submitTranscriptTurn({
      speakerLabel: "1",
      transcript: "James, turn on the kitchen lights",
    });

    expect(result).toMatchObject({
      accepted: true,
      assistantResponse: "response to turn on the kitchen lights",
      speakerName: "Session speaker",
    });
    await expect(service.getSnapshot()).resolves.toMatchObject({
      lockedSpeakerLabel: "1",
    });
    expect(gemini.prompts).toEqual(["turn on the kitchen lights"]);
  });

  it("does not forward ambient transcript text before a wake phrase", async () => {
    const { gemini, service } = await createService();
    await service.startListening();

    const result = await service.submitTranscriptTurn({
      speakerLabel: "1",
      transcript: "turn on the kitchen lights",
    });

    expect(result).toMatchObject({
      accepted: false,
      reason: "wake_phrase_missing",
    });
    expect(gemini.prompts).toEqual([]);
  });

  it("continues a session only for the speaker label that said the wake phrase", async () => {
    const { gemini, service } = await createService();
    await service.startListening();
    await service.submitTranscriptTurn({
      speakerLabel: "1",
      transcript: "James",
    });

    const rejectedResult = await service.submitTranscriptTurn({
      speakerLabel: "2",
      transcript: "turn on the kitchen lights",
    });
    const acceptedResult = await service.submitTranscriptTurn({
      speakerLabel: "1",
      transcript: "turn on the kitchen lights",
    });

    expect(rejectedResult).toMatchObject({
      accepted: false,
      reason: "speaker_label_mismatch",
    });
    expect(acceptedResult).toMatchObject({
      accepted: true,
      assistantResponse: "response to turn on the kitchen lights",
    });
    expect(gemini.prompts).toEqual(["turn on the kitchen lights"]);
  });

  it("ends the active session on a stop command from the locked label", async () => {
    const { gemini, service } = await createService();
    await service.startListening();
    await service.submitTranscriptTurn({
      speakerLabel: "1",
      transcript: "James",
    });

    const result = await service.submitTranscriptTurn({
      speakerLabel: "1",
      transcript: "never mind",
    });

    expect(result).toMatchObject({
      accepted: false,
      reason: "session_ended",
    });
    await expect(service.getSnapshot()).resolves.toMatchObject({
      lockedSpeakerLabel: null,
    });
    expect(gemini.prompts).toEqual([]);
  });
});
