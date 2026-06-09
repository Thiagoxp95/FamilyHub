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

const defaultModel = "gemini-3.1-flash-live-preview";
const defaultVoiceName = "Puck";
const defaultSystemInstruction =
  'You are James, a warm and concise family assistant. James is your assistant name, not a family member or calendar owner. Do not refer to yourself in the third person when summarizing family information. You can read and manage the family Calendar, Reminders, and Notes, and you can control this Mac: whenever the user asks to open an application or do something on the computer, call run_computer_task with a clear description of the task, and never say you are unable to. A "reminder" can live in two places: the Reminders app (a checklist item, via create_reminder) or the Calendar (a timed event with an alert, via create_event). When the user asks to be reminded or to create a reminder without indicating which, ask "On your calendar, or in the Reminders app?" before creating. Skip that question and route directly whenever they give a cue: naming a reminders list (e.g. "add milk to the shopping list") means the Reminders app; saying "calendar", "event", or "appointment" means the Calendar. For a calendar reminder, call create_event for a timed event and pass alarmsMinutesBefore of [0] so it alerts at the event time. Whenever a dashboard quadrant is being discussed, call its show_*_card function so the UI zooms in; when the topic changes away, call the matching hide_*_card function. Use show_notes_card when family notes or post-its are discussed and show_weather_card when weather is discussed. Answer in one or two short sentences, suitable for being spoken aloud. When the user signals they are finished — for example by saying goodbye, bye, see you later, that\'s all, never mind, thanks that\'s it, stop, or shut up — do not say anything in reply. Immediately call the end_conversation function with no spoken farewell.';
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
  updateReminder: "update_reminder",
  completeReminder: "complete_reminder",
  deleteReminder: "delete_reminder",
} as const;

export const noteToolNames = {
  getNotes: "get_notes",
  createNote: "create_note",
  updateNote: "update_note",
  deleteNote: "delete_note",
} as const;

export const weatherToolName = "get_weather";

// Drive the Mac via Codex CLI computer-use (the `cxdo` wrapper).
export const computerToolName = "run_computer_task";

export const updaterToolNames = {
  checkForUpdates: "check_for_updates",
  downloadUpdate: "download_update",
  installUpdate: "install_update",
} as const;

export const dashboardToolNames = {
  showCalendar: "show_calendar_card",
  hideCalendar: "hide_calendar_card",
  showWeather: "show_weather_card",
  hideWeather: "hide_weather_card",
  showReminders: "show_reminders_card",
  hideReminders: "hide_reminders_card",
  showNotes: "show_notes_card",
  hideNotes: "hide_notes_card",
} as const;

const isoHint = "ISO local time, e.g. 2026-06-09T15:00:00 (no timezone suffix)";

const conversationTools = [
  // Ground James' answers in live Google Search results. The Live API accepts
  // the built-in googleSearch tool alongside our function declarations.
  { googleSearch: {} },
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
              description:
                "Future calendar days after today to include, inclusive of the full target day. Example: on June 7, use 2 to include all events through June 9. Default includes the next 14 calendar days.",
            },
          },
        },
      },
      {
        name: calendarToolNames.createEvent,
        description:
          'Create a new calendar event. Also use this for a "calendar reminder": a timed event with an alert at the time — pass alarmsMinutesBefore of [0]. Ask which calendar if the user did not say.',
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
        name: dashboardToolNames.showCalendar,
        description:
          "Expand the calendar quadrant to full screen while calendar events, schedule, appointments, plans, or availability are being discussed.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: dashboardToolNames.hideCalendar,
        description:
          "Collapse the calendar quadrant back to its normal tile when the conversation stops being about events or schedule.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: calendarToolNames.listReminders,
        description:
          "List open reminders with their ids, titles, due dates, and list names. Returns instantly. Call this to answer 'what's on my <list>' questions and to find a reminder's id before completing or deleting it. Optionally pass `list` to return only that list's items (and select its tab).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            list: {
              type: Type.STRING,
              description:
                "Optional list name to limit results to (e.g. 'To Buy', 'House Chores').",
            },
          },
        },
      },
      {
        name: calendarToolNames.createReminder,
        description:
          'Create a reminder in the Reminders app (a checklist item). If the user did not make the destination clear, first ask whether they want it on the calendar or in the Reminders app. Ask which list if the user did not say.',
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
        name: calendarToolNames.updateReminder,
        description:
          "Update an existing reminder (found via list_reminders). Only the provided fields change. Confirm with the user before overwriting.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Reminder id from list_reminders." },
            title: { type: Type.STRING, description: "New reminder title. Omit to leave unchanged." },
            due: { type: Type.STRING, description: `New due date/time, ${isoHint}.` },
            notes: { type: Type.STRING, description: "New notes/body. Omit to leave unchanged." },
          },
          required: ["id"],
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
      {
        name: weatherToolName,
        description:
          "Get the current weather and the 14-day forecast for the home location (La Prairie). Returns current temperature, feels-like, humidity, wind, precipitation, UV, plus a daily forecast with high/low, precipitation amount and chance, humidity, wind, UV, and sunrise/sunset. Call this whenever the user asks about the weather, temperature, rain, snow, or the forecast.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: dashboardToolNames.showWeather,
        description:
          "Expand the weather quadrant to full screen while weather is being discussed.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: dashboardToolNames.hideWeather,
        description:
          "Collapse the weather quadrant back to its normal tile when the conversation stops being about weather.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: dashboardToolNames.showReminders,
        description:
          "Expand the reminders quadrant to full screen while reminders, to-dos, tasks, or lists are being discussed. When the user is asking about a specific list, pass its name in `list` so that list's tab is selected.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            list: {
              type: Type.STRING,
              description:
                "Optional reminders list name to select (e.g. 'To Buy', 'Brasil', 'House Chores'). Use the exact list name from list_reminders when known.",
            },
          },
        },
      },
      {
        name: dashboardToolNames.hideReminders,
        description:
          "Collapse the reminders quadrant back to its normal tile when the conversation stops being about reminders or to-dos.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: noteToolNames.getNotes,
        description:
          "Get the family post-it notes currently on the Notes board, each with its id, text, emoji, and color. Use this for questions about notes, and to find a note id before updating or deleting it.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: noteToolNames.createNote,
        description:
          "Add a new post-it note to the family Notes board. Ask for the text if it is missing. Always choose a mood emoji. Optionally set a sticky color. Call this exactly once per note the user asks for.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "The note text." },
            emoji: {
              type: Type.STRING,
              description:
                "A single emoji matching the note's mood and intent, e.g. 🥛 for milk, 🗑️ for trash, ❤️ for an affectionate note, or 🛒 for shopping.",
            },
            color: {
              type: Type.STRING,
              enum: ["yellow", "pink", "mint", "blue", "orange"],
              description: "Optional sticky color. Omit to auto-assign.",
            },
          },
          required: ["text", "emoji"],
        },
      },
      {
        name: noteToolNames.updateNote,
        description:
          "Edit a post-it note by id: change its text, mood emoji, and/or color. When changing text, also pass an emoji that matches the new text. Use get_notes first if the note id is unknown. Confirm out loud before overwriting.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Note id from get_notes." },
            text: { type: Type.STRING, description: "New note text." },
            emoji: {
              type: Type.STRING,
              description: "A single emoji matching the note's mood and intent.",
            },
            color: {
              type: Type.STRING,
              enum: ["yellow", "pink", "mint", "blue", "orange"],
              description: "New sticky color.",
            },
          },
          required: ["id"],
        },
      },
      {
        name: noteToolNames.deleteNote,
        description:
          "Delete a post-it note by id. Use get_notes first if the note id is unknown. Confirm out loud before deleting.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Note id from get_notes." },
          },
          required: ["id"],
        },
      },
      {
        name: dashboardToolNames.showNotes,
        description:
          "Expand the Notes board to full screen while family notes or post-its are being discussed.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: dashboardToolNames.hideNotes,
        description:
          "Collapse the Notes board back to its normal tile when the conversation stops being about notes.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: computerToolName,
        description:
          "Open applications and take actions on this Mac via Codex computer control. Use this whenever the user asks to open an app, launch a program, browse the web, click, type, or otherwise do something on the computer (e.g. 'open Arc and search for flights', 'play a playlist in Spotify', 'open Notes and write this down'). Pass a clear, complete description of the full task to perform. Tell the user you're on it, then call this; the result is returned when the task finishes.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            task: {
              type: Type.STRING,
              description:
                "A clear, self-contained instruction describing what to do on the computer, including the app and any specifics (what to open, search, type, or click).",
            },
          },
          required: ["task"],
        },
      },
      {
        name: updaterToolNames.checkForUpdates,
        description:
          "Check whether a newer version of the FamilyHub app is available. Reports the current version and whether an update was found. Call this when the user asks about updates or the app version.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: updaterToolNames.downloadUpdate,
        description:
          "Download an available update now. Updates normally download automatically in the background, so only use this if the user explicitly asks to download an available update right away.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: updaterToolNames.installUpdate,
        description:
          "Install a downloaded update and relaunch the app. Only works once an update has finished downloading. This restarts the app, so confirm out loud with the user before calling it.",
        parameters: { type: Type.OBJECT, properties: {} },
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
    "You can read and manage the family Calendar, Reminders, and Notes, and read the weather, using the provided tools. Resolve relative times like \"tomorrow at 3pm\", \"in an hour\", or \"next Monday\" into absolute ISO local datetimes (YYYY-MM-DDTHH:MM:SS) based on the current time above.",
    "You CAN control this Mac: whenever the user asks to open an application or do anything on the computer (open an app, launch a program, browse the web, search, click, type, play music, etc.), call run_computer_task with a clear description of the full task. Briefly say you're on it before calling it, and never claim you are unable to control the computer.",
    "For any weather, temperature, rain, snow, or forecast question, call get_weather to fetch live conditions and the 14-day forecast instead of guessing; temperatures are in Celsius.",
    "Whenever a dashboard quadrant is being discussed, call its show_*_card function so the UI zooms in. Use show_calendar_card for schedule topics, show_weather_card for weather topics, show_reminders_card for reminders or lists, and show_notes_card for family notes or post-its. When discussing a specific reminders list (e.g. 'To Buy', 'Brasil', 'House Chores'), call show_reminders_card with its `list` name so that list's tab is selected. When the user changes away from that topic, call the matching hide_*_card function.",
    "To change or remove an existing event or reminder, first call list_events or list_reminders to find its id, then act on that id. list_reminders returns instantly, so always read it (don't guess) when asked what's on a list, then say the items out loud.",
    "To mark a reminder done, call list_reminders (optionally with the list name) to get the matching item's id, then call complete_reminder with that id and briefly confirm.",
    "To change or remove an existing note, first call get_notes to find its id, then act on that id.",
    "ALWAYS confirm out loud before deleting or overwriting something — say what you are about to change and only do it after the user agrees. You may create new items directly, including notes.",
    "If the user does not say which calendar or reminders list, ask which one.",
    "For alarms use alarmsMinutesBefore (minutes before the event): [60] one hour before, [1440] one day before.",
    "After making a change, briefly confirm what you did. Keep every reply to one or two short sentences, suitable for being spoken aloud.",
    "You can manage app updates: call check_for_updates to see whether a newer version is available, download_update to download an available update immediately, and install_update to install a downloaded update and relaunch the app. Always confirm out loud before calling install_update, since it restarts the app.",
    "When the user signals they are finished — goodbye, bye, that's all, never mind, thanks that's it, stop, or shut up — do not say anything in reply; immediately call the end_conversation function with no spoken farewell.",
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
    // Resolve only once Gemini sends `setupComplete`. The websocket opening (what
    // connect() awaits) is NOT enough: sending realtimeInput before setupComplete
    // is rejected with "Precondition check failed" and the session is dropped. So
    // "started" must mean "ready for input" — otherwise a buffered-audio flush on
    // open races the handshake and the session closes in a split second.
    let settled = false;
    let markReady: () => void = () => {};
    let markFailed: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      markReady = resolveReady;
      markFailed = rejectReady;
    });

    this.session = await this.ai.live.connect({
      callbacks: {
        onopen: () => {},
        onmessage: (message: LiveServerMessage) => {
          if (!settled && message.setupComplete) {
            settled = true;
            markReady();
          }

          for (const event of interpretLiveMessage(message)) {
            handlers.onEvent(event);
          }
        },
        onerror: (error: unknown) => {
          const message = readErrorMessage(error);
          if (!settled) {
            settled = true;
            markFailed(new Error(message));
          }
          handlers.onError(message);
        },
        onclose: (event: { reason?: string } | undefined) => {
          const reason = event?.reason ?? "closed";
          if (!settled) {
            settled = true;
            markFailed(new Error(reason || "closed before setup"));
          }
          handlers.onClosed(reason);
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
        // Audio-only Live sessions have a ~15-min server-side duration cap, after
        // which Gemini sends `goAway` and disconnects. A sliding-window context
        // compression lifts that cap so a long conversation isn't torn down by the
        // server. (Unrelated to the local idle timer, which handles silence.)
        contextWindowCompression: { slidingWindow: {} },
      },
      model: this.model,
    });

    await ready;
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
