import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { readAssistantConfigStatus } from "./config";
import { EnrollmentStore } from "./enrollmentStore";
import { FileSpeakerProfileStore } from "./profileStore";
import { AssistantService, PlaceholderGeminiLive, type GeminiLiveAdapter } from "./service";
import { VoiceprintStore } from "./voiceprintStore";

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

describe("enrollment clips", () => {
  it("saves a clip and reports sampleCount in the snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-svc-"));
    const service = new AssistantService({
      gemini: new PlaceholderGeminiLive(),
      profileStore: new FileSpeakerProfileStore(dir),
      enrollmentStore: new EnrollmentStore(dir),
    });
    const speaker = await service.enrollSpeaker("Mom");

    const b64 = Buffer.from(new Int16Array([7, -7]).buffer).toString("base64");
    expect(await service.saveEnrollmentClip(speaker.id, b64)).toEqual({
      sampleCount: 1,
    });

    const snap = await service.getSnapshot();
    const mom = snap.speakers.find((s) => s.id === speaker.id);
    expect(mom?.sampleCount).toBe(1);
  });

  it("removes clips when the speaker is deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-svc-"));
    const enrollmentStore = new EnrollmentStore(dir);
    const service = new AssistantService({
      gemini: new PlaceholderGeminiLive(),
      profileStore: new FileSpeakerProfileStore(dir),
      enrollmentStore,
    });
    const speaker = await service.enrollSpeaker("Kid");
    const b64 = Buffer.from(new Int16Array([1]).buffer).toString("base64");
    await service.saveEnrollmentClip(speaker.id, b64);

    await service.deleteSpeaker(speaker.id);
    expect(await enrollmentStore.countClips(speaker.id)).toBe(0);
  });

  it("finalizeEnrollment computes a voiceprint and reports hasVoiceprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-svc-vp-"));
    const fakePy = join(dir, "fakepy.sh");
    await writeFile(fakePy, '#!/bin/sh\nprintf "[1, 0]"\n');
    await chmod(fakePy, 0o755);
    const service = new AssistantService({
      gemini: new PlaceholderGeminiLive(),
      profileStore: new FileSpeakerProfileStore(dir),
      enrollmentStore: new EnrollmentStore(dir),
      voiceprintStore: new VoiceprintStore(dir, fakePy, "x.py"),
    });
    const sp = await service.enrollSpeaker("Mom");
    const b64 = Buffer.from(new Int16Array([1, 2]).buffer).toString("base64");
    await service.saveEnrollmentClip(sp.id, b64);
    await service.finalizeEnrollment(sp.id);
    const snap = await service.getSnapshot();
    expect(snap.speakers.find((s) => s.id === sp.id)?.hasVoiceprint).toBe(true);
  });
});
