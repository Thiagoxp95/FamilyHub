import { beforeEach, describe, expect, it } from "vitest";
import { readAssistantConfigStatus } from "./config";
import { AssistantService } from "./service";

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
    expect(readAssistantConfigStatus(process.env, () => false)).toEqual({
      gemini: false,
      googleSpeech: false,
      localListener: false,
    });

    process.env.GEMINI_API_KEY = "gemini";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/google.json";

    expect(readAssistantConfigStatus(process.env, () => true)).toEqual({
      gemini: true,
      googleSpeech: true,
      localListener: true,
    });
  });

  it("accepts GOOGLE_API as a Gemini API key alias", () => {
    process.env.GOOGLE_API = "gemini";

    expect(readAssistantConfigStatus().gemini).toBe(true);
  });
});

describe("AssistantService", () => {
  it("starts and stops listening, reflecting state in the snapshot", async () => {
    const service = new AssistantService();

    const started = await service.startListening();
    expect(started.isListening).toBe(true);
    expect(started.wakePhrase).toBe("Hey James");

    const stopped = await service.stopListening();
    expect(stopped.isListening).toBe(false);
  });

  it("records heard transcripts and assistant replies in the snapshot", async () => {
    const service = new AssistantService();

    service.noteHeard("turn on the lights");
    service.noteAssistantReply("Sure, lights are on.");

    const snapshot = await service.getSnapshot();
    expect(snapshot.lastTranscript).toBe("turn on the lights");
    expect(snapshot.lastAssistantResponse).toBe("Sure, lights are on.");
  });
});
