import {
  GoogleGenAI,
  Modality,
  Type,
  type LiveServerMessage,
  type Session,
} from "@google/genai";

// A single bidirectional Gemini Live native-audio conversation: caller streams
// 16 kHz LINEAR16 microphone frames in; Gemini streams 24 kHz audio + input and
// output transcripts back. This wraps the websocket so the rest of the app deals
// in plain LiveEvents.

export type LiveEvent =
  | { kind: "inputTranscript"; text: string }
  | { kind: "outputTranscript"; text: string }
  | { kind: "audio"; data: string; mimeType: string }
  | { kind: "toolCall"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "interrupted" }
  | { kind: "turnComplete" };

export interface LiveSessionHandlers {
  onEvent: (event: LiveEvent) => void;
  onClosed: (reason: string) => void;
  onError: (message: string) => void;
}

export interface GeminiLiveSessionOptions {
  apiKey: string;
  model?: string;
  voiceName?: string;
  systemInstruction?: string;
}

const defaultModel = "gemini-2.5-flash-native-audio-preview-12-2025";
const defaultVoiceName = "Puck";
const defaultSystemInstruction =
  "You are James, a warm and concise family assistant. James is your assistant name, not a family member or calendar owner. Do not refer to yourself in the third person when summarizing family information. Answer in one or two short sentences, suitable for being spoken aloud. When the user signals they are finished — for example by saying goodbye, bye, see you later, that's all, never mind, thanks that's it, stop, or shut up — give a brief one-line farewell and then call the end_conversation function.";
const inputMimeType = "audio/pcm;rate=16000";

export const endConversationToolName = "end_conversation";

// Tool names the controller dispatches to the Calendar/Reminders layer.
export const calendarToolNames = {
  listEvents: "list_events",
  createEvent: "create_event",
  updateEvent: "update_event",
  deleteEvent: "delete_event",
  listReminders: "list_reminders",
  createReminder: "create_reminder",
  completeReminder: "complete_reminder",
  deleteReminder: "delete_reminder",
} as const;

const isoHint = "ISO local time, e.g. 2026-06-09T15:00:00 (no timezone suffix)";

const conversationTools = [
  {
    functionDeclarations: [
      {
        name: endConversationToolName,
        description:
          'End the current voice conversation and return to waiting for the wake word. Call this as soon as the user signals they are done — e.g. "goodbye", "bye", "see you later", "that\'s all", "that\'s it", "never mind", "thanks that\'s all", "stop", or "shut up".',
        parameters: {
          type: Type.OBJECT,
          properties: {
            reason: {
              type: Type.STRING,
              description:
                "A short phrase describing why the conversation is ending (e.g. 'user said goodbye').",
            },
          },
        },
      },
      {
        name: calendarToolNames.listEvents,
        description:
          "List upcoming calendar events (with their ids, needed to update or delete an event). Call this before changing or removing an event the user refers to.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            daysAhead: {
              type: Type.NUMBER,
              description: "How many days ahead to include (default 14).",
            },
          },
        },
      },
      {
        name: calendarToolNames.createEvent,
        description:
          "Create a new calendar event. Ask which calendar if the user did not say.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            start: { type: Type.STRING, description: `Start, ${isoHint}.` },
            end: {
              type: Type.STRING,
              description: `Optional end, ${isoHint}. Defaults to one hour after start.`,
            },
            allDay: { type: Type.BOOLEAN },
            calendar: {
              type: Type.STRING,
              description: "Calendar name to add the event to.",
            },
            alarmsMinutesBefore: {
              type: Type.ARRAY,
              items: { type: Type.NUMBER },
              description:
                "Alarms as minutes before the event: [60] = 1 hour before, [1440] = 1 day before, [60,1440] = both.",
            },
          },
          required: ["title", "start"],
        },
      },
      {
        name: calendarToolNames.updateEvent,
        description:
          "Update an existing event (found via list_events). Only the provided fields change. Confirm with the user before overwriting.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Event id from list_events." },
            title: { type: Type.STRING },
            start: { type: Type.STRING, description: `New start, ${isoHint}.` },
            end: { type: Type.STRING, description: `New end, ${isoHint}.` },
            allDay: { type: Type.BOOLEAN },
            alarmsMinutesBefore: {
              type: Type.ARRAY,
              items: { type: Type.NUMBER },
              description: "Replaces the event's alarms (minutes before).",
            },
          },
          required: ["id"],
        },
      },
      {
        name: calendarToolNames.deleteEvent,
        description:
          "Delete a calendar event by id (found via list_events). Confirm with the user out loud first.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Event id from list_events." },
          },
          required: ["id"],
        },
      },
      {
        name: calendarToolNames.listReminders,
        description:
          "List open reminders (with their ids and lists), needed to complete or delete one.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: calendarToolNames.createReminder,
        description:
          "Create a reminder. Ask which list if the user did not say.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            due: { type: Type.STRING, description: `Optional due date/time, ${isoHint}.` },
            list: { type: Type.STRING, description: "Reminders list name." },
            notes: { type: Type.STRING },
          },
          required: ["title"],
        },
      },
      {
        name: calendarToolNames.completeReminder,
        description: "Mark a reminder done by id (found via list_reminders).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Reminder id from list_reminders." },
          },
          required: ["id"],
        },
      },
      {
        name: calendarToolNames.deleteReminder,
        description:
          "Delete a reminder by id (found via list_reminders). Confirm with the user out loud first.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Reminder id from list_reminders." },
          },
          required: ["id"],
        },
      },
    ],
  },
];

// System instruction with the current local date/time injected, so the model
// resolves "tomorrow at 3pm" / "in an hour" against the right clock.
export function buildSystemInstruction(now: Date = new Date()): string {
  const when = now.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return [
    "You are James, a warm and concise family assistant. James is your assistant name, not a family member or calendar owner. Do not refer to yourself in the third person when summarizing family information.",
    `The current date and time is ${when} (timezone America/Toronto, in La Prairie, Québec).`,
    "You can read and manage the family Calendar and Reminders using the provided tools. Resolve relative times like \"tomorrow at 3pm\", \"in an hour\", or \"next Monday\" into absolute ISO local datetimes (YYYY-MM-DDTHH:MM:SS) based on the current time above.",
    "To change or remove an existing event or reminder, first call list_events or list_reminders to find its id, then act on that id.",
    "ALWAYS confirm out loud before deleting or overwriting something — say what you are about to change and only do it after the user agrees. You may create new items directly.",
    "If the user does not say which calendar or reminders list, ask which one.",
    "For alarms use alarmsMinutesBefore (minutes before the event): [60] one hour before, [1440] one day before.",
    "After making a change, briefly confirm what you did. Keep every reply to one or two short sentences, suitable for being spoken aloud.",
    "When the user signals they are finished — goodbye, bye, that's all, never mind, thanks that's it, stop, or shut up — give a brief one-line farewell and then call the end_conversation function.",
  ].join(" ");
}

// Pure translation of a raw Live server message into ordered LiveEvents. Kept
// separate from the socket so it can be unit tested.
export function interpretLiveMessage(message: LiveServerMessage): LiveEvent[] {
  const events: LiveEvent[] = [];

  for (const call of message.toolCall?.functionCalls ?? []) {
    events.push({
      kind: "toolCall",
      id: call.id ?? "",
      name: call.name ?? "",
      args: (call.args as Record<string, unknown> | undefined) ?? {},
    });
  }

  const serverContent = message.serverContent;

  if (!serverContent) {
    return events;
  }

  if (serverContent.inputTranscription?.text) {
    events.push({
      kind: "inputTranscript",
      text: serverContent.inputTranscription.text,
    });
  }

  if (serverContent.outputTranscription?.text) {
    events.push({
      kind: "outputTranscript",
      text: serverContent.outputTranscription.text,
    });
  }

  for (const part of serverContent.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) {
      events.push({
        kind: "audio",
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType ?? "audio/pcm;rate=24000",
      });
    }
  }

  if (serverContent.interrupted) {
    events.push({ kind: "interrupted" });
  }

  if (serverContent.turnComplete) {
    events.push({ kind: "turnComplete" });
  }

  return events;
}

export class GeminiLiveSession {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly voiceName: string;
  private readonly systemInstruction: string;
  private session: Session | null = null;

  constructor({
    apiKey,
    model = defaultModel,
    voiceName = defaultVoiceName,
    systemInstruction = defaultSystemInstruction,
  }: GeminiLiveSessionOptions) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
    this.voiceName = voiceName;
    this.systemInstruction = systemInstruction;
  }

  async start(handlers: LiveSessionHandlers): Promise<void> {
    this.session = await this.ai.live.connect({
      callbacks: {
        onopen: () => {},
        onmessage: (message: LiveServerMessage) => {
          for (const event of interpretLiveMessage(message)) {
            handlers.onEvent(event);
          }
        },
        onerror: (error: unknown) => {
          handlers.onError(readErrorMessage(error));
        },
        onclose: (event: { reason?: string } | undefined) => {
          handlers.onClosed(event?.reason ?? "closed");
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } },
        },
        systemInstruction: { parts: [{ text: this.systemInstruction }] },
        tools: conversationTools,
      },
      model: this.model,
    });
  }

  sendAudioFrame(base64Pcm16k: string): void {
    this.session?.sendRealtimeInput({
      audio: { data: base64Pcm16k, mimeType: inputMimeType },
    });
  }

  sendToolResponse(
    id: string,
    name: string,
    response: Record<string, unknown>,
  ): void {
    this.session?.sendToolResponse({
      functionResponses: [id ? { id, name, response } : { name, response }],
    });
  }

  async close(): Promise<void> {
    try {
      this.session?.close();
    } catch {
      // Already closing/closed — nothing to do.
    }

    this.session = null;
  }

  get isOpen(): boolean {
    return this.session !== null;
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Gemini Live session error.";
}
