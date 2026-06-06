import { ipcMain, type WebContents } from "electron";
import { detectWakeWord, processLinear16AudioChunk } from "./audioPipeline";
import {
  GeminiLiveSession,
  endConversationToolName,
  type LiveEvent,
} from "./liveSession";
import { FileSpeakerProfileStore } from "./profileStore";
import { AssistantService, PlaceholderGeminiLive } from "./service";
import type { AssistantSnapshot } from "./types";
import {
  GeminiLiveTextAdapter,
  GoogleSpeechDiarizationAdapter,
} from "./vendorAdapters";

const assistantStateChannel = "assistant:state";
const liveStateChannel = "assistant:live";
const liveAudioChannel = "assistant:liveAudio";
const wakePhrases = ["james"];
const displayWakePhrase = "James";
const liveIdleTimeoutMs = 18_000;

export function registerAssistantIpc(userDataDirectory: string): void {
  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_API;
  const gemini = geminiApiKey
    ? new GeminiLiveTextAdapter({ apiKey: geminiApiKey })
    : new PlaceholderGeminiLive();
  const speech = readGoogleSpeechConfigured()
    ? new GoogleSpeechDiarizationAdapter()
    : null;
  const service = new AssistantService({
    gemini,
    profileStore: new FileSpeakerProfileStore(userDataDirectory),
  });

  // ----- Live audio conversation state (single active session) -----
  let liveSession: GeminiLiveSession | null = null;
  let liveActive = false;
  let liveSender: WebContents | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let endFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let endRequested = false;
  let endReason = "goodbye";
  let inputTurnBuffer = "";
  let outputTurnBuffer = "";

  function sendLive(sender: WebContents, payload: unknown): void {
    if (!sender.isDestroyed()) {
      sender.send(liveStateChannel, payload);
    }
  }

  function armIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
      void endLive("timed out");
    }, liveIdleTimeoutMs);
  }

  function handleLiveEvent(event: LiveEvent): void {
    const sender = liveSender;

    if (!sender) {
      return;
    }

    switch (event.kind) {
      case "inputTranscript":
        inputTurnBuffer += event.text;
        armIdleTimer();
        sendLive(sender, { type: "inputTranscript", text: inputTurnBuffer });
        break;
      case "outputTranscript":
        outputTurnBuffer += event.text;
        sendLive(sender, { type: "outputTranscript", text: outputTurnBuffer });
        break;
      case "audio":
        if (!sender.isDestroyed()) {
          sender.send(liveAudioChannel, {
            data: event.data,
            mimeType: event.mimeType,
          });
        }
        break;
      case "toolCall":
        if (event.name === endConversationToolName) {
          liveSession?.sendToolResponse(event.id, event.name, {
            status: "ended",
          });
          endRequested = true;
          endReason =
            typeof event.args.reason === "string" && event.args.reason.trim()
              ? event.args.reason.trim()
              : "said goodbye";

          // Safety net: end even if the farewell turn never completes.
          if (endFallbackTimer) {
            clearTimeout(endFallbackTimer);
          }

          endFallbackTimer = setTimeout(() => {
            void endLive(endReason);
          }, 5_000);
        }
        break;
      case "interrupted":
        outputTurnBuffer = "";
        sendLive(sender, { type: "interrupted" });
        break;
      case "turnComplete":
        if (inputTurnBuffer.trim().length > 0) {
          service.noteHeard(inputTurnBuffer);
        }

        if (outputTurnBuffer.trim().length > 0) {
          service.noteAssistantReply(outputTurnBuffer);
        }

        inputTurnBuffer = "";
        outputTurnBuffer = "";
        sendLive(sender, { type: "turnComplete" });
        void emitSnapshot(sender, service);

        // If the assistant called end_conversation, the farewell turn has now
        // finished playing — close the session instead of waiting for silence.
        if (endRequested) {
          void endLive(endReason);
          return;
        }

        armIdleTimer();
        break;
    }
  }

  async function startLive(sender: WebContents): Promise<void> {
    if (liveActive || !geminiApiKey) {
      return;
    }

    liveActive = true;
    liveSender = sender;
    inputTurnBuffer = "";
    outputTurnBuffer = "";
    endRequested = false;
    const session = new GeminiLiveSession({ apiKey: geminiApiKey });
    liveSession = session;

    try {
      await session.start({
        onEvent: handleLiveEvent,
        onClosed: (reason) => {
          void endLive(reason);
        },
        onError: (message) => {
          sendLive(sender, { type: "status", message });
          void endLive("error");
        },
      });
    } catch (error) {
      liveActive = false;
      liveSession = null;
      liveSender = null;
      sendLive(sender, {
        type: "status",
        message: `Could not start live session: ${readErrorMessage(error)}`,
      });
      sendLive(sender, { type: "mode", mode: "wake" });
      return;
    }

    service.noteInfo(`Wake word heard — live session with ${displayWakePhrase} started.`);
    sendLive(sender, { type: "mode", mode: "live" });
    sendLive(sender, { type: "status", message: "Live — go ahead and talk." });
    void emitSnapshot(sender, service);
    armIdleTimer();
  }

  async function endLive(reason: string): Promise<void> {
    if (!liveActive) {
      return;
    }

    liveActive = false;
    endRequested = false;

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (endFallbackTimer) {
      clearTimeout(endFallbackTimer);
      endFallbackTimer = null;
    }

    const sender = liveSender;
    const session = liveSession;
    liveSender = null;
    liveSession = null;
    inputTurnBuffer = "";
    outputTurnBuffer = "";

    await session?.close();
    service.noteInfo(`Live session ended (${reason}).`);

    if (sender && !sender.isDestroyed()) {
      sendLive(sender, { type: "status", message: `Session ended (${reason}).` });
      sendLive(sender, { type: "mode", mode: "wake" });
      void emitSnapshot(sender, service);
    }
  }

  // ----- IPC handlers -----
  ipcMain.handle("assistant:getSnapshot", async () => service.getSnapshot());

  ipcMain.handle("assistant:enrollSpeaker", async (event, name: unknown) => {
    const speaker = await service.enrollSpeaker(requireString(name, "Speaker name"));
    await emitSnapshot(event.sender, service);
    return speaker;
  });

  ipcMain.handle(
    "assistant:setSpeakerAllowed",
    async (event, speakerId: unknown, allowed: unknown) => {
      const speaker = await service.setSpeakerAllowed(
        requireString(speakerId, "Speaker id"),
        requireBoolean(allowed, "Allowed"),
      );
      await emitSnapshot(event.sender, service);
      return speaker;
    },
  );

  ipcMain.handle("assistant:deleteSpeaker", async (event, speakerId: unknown) => {
    const deleted = await service.deleteSpeaker(requireString(speakerId, "Speaker id"));
    await emitSnapshot(event.sender, service);
    return deleted;
  });

  ipcMain.handle("assistant:startListening", async (event) => {
    const snapshot = await service.startListening();
    event.sender.send(assistantStateChannel, snapshot);
    return snapshot;
  });

  ipcMain.handle("assistant:stopListening", async (event) => {
    await endLive("stopped");
    const snapshot = await service.stopListening();
    event.sender.send(assistantStateChannel, snapshot);
    return snapshot;
  });

  ipcMain.handle(
    "assistant:lockSessionSpeaker",
    async (event, speakerId: unknown, speakerLabel: unknown) => {
      const snapshot = await service.lockSessionSpeaker(
        requireString(speakerId, "Speaker id"),
        requireString(speakerLabel, "Speaker label"),
      );
      event.sender.send(assistantStateChannel, snapshot);
      return snapshot;
    },
  );

  ipcMain.handle(
    "assistant:submitTranscript",
    async (event, transcript: unknown, speakerLabel: unknown) => {
      const result = await service.submitTranscriptTurn({
        speakerLabel: requireString(speakerLabel, "Speaker label"),
        transcript: requireString(transcript, "Transcript"),
      });
      await emitSnapshot(event.sender, service);
      return result;
    },
  );

  // Idle wake-word detection: transcribe a chunk; if the wake phrase is heard,
  // open a live audio session.
  ipcMain.handle(
    "assistant:detectWake",
    async (event, audio: unknown, sampleRateHertz: unknown) => {
      if (!speech) {
        throw new Error("Google Speech is not configured.");
      }

      if (liveActive) {
        return { woke: true };
      }

      const result = await detectWakeWord({
        audio: requireUint8Array(audio, "Audio"),
        sampleRateHertz: requirePositiveNumber(sampleRateHertz, "Sample rate hertz"),
        speech,
        wakePhrases,
      });

      if (result.woke) {
        await startLive(event.sender);
      }

      return { woke: result.woke };
    },
  );

  // Streaming microphone frames during a live session (base64 LINEAR16 @16 kHz).
  ipcMain.on("assistant:liveFrame", (_event, frame: unknown) => {
    if (liveActive && liveSession && typeof frame === "string") {
      liveSession.sendAudioFrame(frame);
    }
  });

  ipcMain.handle("assistant:endLive", async () => {
    await endLive("stopped");
    return true;
  });

  // Retained for the diagnostics panel / manual chunk submission.
  ipcMain.handle(
    "assistant:submitAudioChunk",
    async (event, audio: unknown, sampleRateHertz: unknown) => {
      if (!speech) {
        throw new Error("Google Speech is not configured.");
      }

      const result = await processLinear16AudioChunk({
        audio: requireUint8Array(audio, "Audio"),
        sampleRateHertz: requirePositiveNumber(
          sampleRateHertz,
          "Sample rate hertz",
        ),
        service,
        speech,
      });
      await emitSnapshot(event.sender, service);
      return result;
    },
  );
}

async function emitSnapshot(
  webContents: WebContents,
  service: AssistantService,
): Promise<void> {
  if (webContents.isDestroyed()) {
    return;
  }

  const snapshot: AssistantSnapshot = await service.getSnapshot();
  webContents.send(assistantStateChannel, snapshot);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return value;
}

function requireUint8Array(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error(`${label} must be bytes.`);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unexpected error.";
}

function readGoogleSpeechConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      process.env.GOOGLE_CLOUD_PROJECT?.trim(),
  );
}
