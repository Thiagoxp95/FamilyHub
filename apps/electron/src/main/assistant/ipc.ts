import { ipcMain, type WebContents } from "electron";
import { processLinear16AudioChunk } from "./audioPipeline";
import * as calendarTools from "./calendarTools";
import {
  GeminiLiveSession,
  buildSystemInstruction,
  calendarToolNames,
} from "./liveSession";
import {
  LiveController,
  type LiveControllerSink,
  type LiveStateEvent,
  type ToolRunner,
} from "./liveController";
import {
  WakeWordSidecar,
  resolveSidecarPython,
  resolveSidecarScript,
  type LocalTranscriber,
} from "./localTranscriber";
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

export interface DashboardRefresh {
  refreshCalendar: () => Promise<void>;
  refreshReminders: () => Promise<void>;
}

export function registerAssistantIpc(
  userDataDirectory: string,
  dashboard?: DashboardRefresh,
): void {
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

  // The single renderer we stream live state to. Set when the renderer starts
  // listening; the controller pushes mode/transcript/audio events at it.
  let liveSender: WebContents | null = null;

  function sendLive(event: LiveStateEvent): void {
    if (liveSender && !liveSender.isDestroyed()) {
      liveSender.send(liveStateChannel, event);
    }
  }

  const sink: LiveControllerSink = {
    sendLive,
    sendLiveAudio: (chunk) => {
      if (liveSender && !liveSender.isDestroyed()) {
        liveSender.send(liveAudioChannel, chunk);
      }
    },
    noteHeard: (text) => service.noteHeard(text),
    noteAssistantReply: (text) => service.noteAssistantReply(text),
    noteInfo: (message) => service.noteInfo(message),
    emitSnapshot: () => {
      if (liveSender) {
        void emitSnapshot(liveSender, service);
      }
    },
  };

  // Dispatch a Gemini tool call to the Calendar/Reminders layer, refreshing the
  // affected dashboard card after a write so the change shows immediately.
  const runTool: ToolRunner = async (name, args) => {
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const optStr = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v : undefined;
    const minutes = (v: unknown): number[] | undefined =>
      Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : undefined;

    switch (name) {
      case calendarToolNames.listEvents:
        return {
          ok: true,
          events: await calendarTools.listEvents(
            typeof args.daysAhead === "number" ? args.daysAhead : undefined,
          ),
        };
      case calendarToolNames.createEvent: {
        const event = await calendarTools.createEvent({
          title: str(args.title),
          start: str(args.start),
          end: optStr(args.end),
          allDay: args.allDay === true,
          calendar: optStr(args.calendar),
          alarmsMinutesBefore: minutes(args.alarmsMinutesBefore),
        });
        await dashboard?.refreshCalendar();
        return { ok: true, event };
      }
      case calendarToolNames.updateEvent: {
        await calendarTools.updateEvent({
          id: str(args.id),
          title: optStr(args.title),
          start: optStr(args.start),
          end: optStr(args.end),
          allDay: typeof args.allDay === "boolean" ? args.allDay : undefined,
          alarmsMinutesBefore: minutes(args.alarmsMinutesBefore),
        });
        await dashboard?.refreshCalendar();
        return { ok: true };
      }
      case calendarToolNames.deleteEvent:
        await calendarTools.deleteEvent(str(args.id));
        await dashboard?.refreshCalendar();
        return { ok: true };
      case calendarToolNames.listReminders:
        return { ok: true, reminders: await calendarTools.listReminders() };
      case calendarToolNames.createReminder: {
        const result = await calendarTools.createReminder({
          title: str(args.title),
          due: optStr(args.due),
          list: optStr(args.list),
          notes: optStr(args.notes),
        });
        await dashboard?.refreshReminders();
        return { ok: true, list: result.list };
      }
      case calendarToolNames.completeReminder:
        await calendarTools.completeReminder(str(args.id));
        await dashboard?.refreshReminders();
        return { ok: true };
      case calendarToolNames.deleteReminder:
        await calendarTools.deleteReminder(str(args.id));
        await dashboard?.refreshReminders();
        return { ok: true };
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  };

  const sidecarPython = resolveSidecarPython();
  const sidecarScript = resolveSidecarScript();
  const controller =
    geminiApiKey && sidecarPython && sidecarScript
      ? new LiveController({
          createTranscriber: (): LocalTranscriber =>
            new WakeWordSidecar(sidecarPython, sidecarScript),
          createSession: () =>
            new GeminiLiveSession({
              apiKey: geminiApiKey,
              systemInstruction: buildSystemInstruction(),
            }),
          runTool,
          sink,
        })
      : null;

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
    liveSender = event.sender;

    if (controller) {
      await controller.start();
    } else {
      service.noteInfo(
        "Local listener unavailable — set up the Parakeet sidecar (see sidecar/README.md).",
      );
    }

    const snapshot = await service.startListening();
    event.sender.send(assistantStateChannel, snapshot);
    return snapshot;
  });

  ipcMain.handle("assistant:stopListening", async (event) => {
    await controller?.stop();
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

  // Continuous microphone stream (base64 LINEAR16 @16 kHz). The controller feeds
  // every frame to the local listener and decides what to buffer/forward.
  ipcMain.on("assistant:micFrame", (event, frame: unknown) => {
    if (typeof frame === "string") {
      liveSender = event.sender;
      controller?.handleFrame(frame);
    }
  });

  ipcMain.handle("assistant:endLive", async () => {
    await controller?.endLive();
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
        sampleRateHertz: requirePositiveNumber(sampleRateHertz, "Sample rate hertz"),
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

function readGoogleSpeechConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      process.env.GOOGLE_CLOUD_PROJECT?.trim(),
  );
}
