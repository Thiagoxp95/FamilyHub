/// <reference types="vite/client" />

interface AssistantConfigStatus {
  gemini: boolean;
  googleSpeech: boolean;
  localListener: boolean;
}

interface SpeakerProfileSummary {
  allowed: boolean;
  createdAt: string;
  id: string;
  name: string;
}

interface AssistantEvent {
  at: string;
  message: string;
  type: "accepted" | "assistant" | "ignored" | "info" | "error";
}

interface AssistantSnapshot {
  config: AssistantConfigStatus;
  currentSpeakerName: string | null;
  events: AssistantEvent[];
  isListening: boolean;
  lastAssistantResponse: string | null;
  lastTranscript: string | null;
  lockedSpeakerLabel: string | null;
  sessionExpiresAt: string | null;
  speakers: SpeakerProfileSummary[];
  wakePhrase: string;
}

type TranscriptTurnResult =
  | {
      accepted: true;
      assistantResponse: string;
      speakerLabel: string;
      speakerName: string;
    }
  | {
      accepted: false;
      reason:
        | "session_ended"
        | "speaker_label_mismatch"
        | "wake_command_missing"
        | "wake_phrase_missing";
      speakerLabel: string;
      speakerName?: string;
    };

type LiveMode = "wake" | "live";

type LiveStateEvent =
  | { type: "mode"; mode: LiveMode }
  | { type: "inputTranscript"; text: string }
  | { type: "outputTranscript"; text: string }
  | { type: "status"; message: string }
  | { type: "listener"; state: "loading" | "ready" | "offline"; detail?: string }
  | { type: "interrupted" }
  | { type: "turnComplete" };

interface LiveAudioChunk {
  data: string;
  mimeType: string;
}

interface AssistantBridge {
  deleteSpeaker: (speakerId: string) => Promise<boolean>;
  enrollSpeaker: (name: string) => Promise<SpeakerProfileSummary>;
  getSnapshot: () => Promise<AssistantSnapshot>;
  lockSessionSpeaker: (
    speakerId: string,
    speakerLabel: string,
  ) => Promise<AssistantSnapshot>;
  onSnapshot: (callback: (snapshot: AssistantSnapshot) => void) => () => void;
  setSpeakerAllowed: (
    speakerId: string,
    allowed: boolean,
  ) => Promise<SpeakerProfileSummary | null>;
  startListening: () => Promise<AssistantSnapshot>;
  stopListening: () => Promise<AssistantSnapshot>;
  submitAudioChunk: (
    audio: Uint8Array,
    sampleRateHertz: number,
  ) => Promise<TranscriptTurnResult[]>;
  submitTranscript: (
    transcript: string,
    speakerLabel: string,
  ) => Promise<TranscriptTurnResult>;
  sendMicFrame: (frame: string) => void;
  endLive: () => Promise<boolean>;
  onLive: (callback: (event: LiveStateEvent) => void) => () => void;
  onLiveAudio: (callback: (chunk: LiveAudioChunk) => void) => () => void;
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
}

type WeatherCategory =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunder";

interface WeatherCondition {
  category: WeatherCategory;
  code: number;
  isDay: boolean;
  label: string;
}

interface WeatherSnapshot {
  apparentC: number;
  city: string | null;
  condition: WeatherCondition;
  highC: number;
  humidity: number | null;
  lowC: number;
  temperatureC: number;
  updatedAt: string;
  windMph: number | null;
}

type WeatherResult =
  | { ok: true; weather: WeatherSnapshot }
  | { ok: false; error: string };

interface CalendarEvent {
  allDay: boolean;
  calendar: string;
  end: string;
  start: string;
  title: string;
}

type CalendarResult =
  | { status: "ok"; events: CalendarEvent[] }
  | { status: "writeOnly" }
  | { status: "denied" }
  | { status: "error"; error: string };

interface ReminderItem {
  due?: string;
  title: string;
}

interface ReminderList {
  items: ReminderItem[];
  name: string;
}

type RemindersResult =
  | { status: "ok"; lists: ReminderList[] }
  | { status: "denied" }
  | { status: "error"; error: string };

interface DashboardBridge {
  getWeather: () => Promise<WeatherResult>;
  onWeather: (callback: (result: WeatherResult) => void) => () => void;
  getCalendar: () => Promise<CalendarResult>;
  onCalendar: (callback: (result: CalendarResult) => void) => () => void;
  getReminders: () => Promise<RemindersResult>;
  onReminders: (callback: (result: RemindersResult) => void) => () => void;
  connectCalendar: () => Promise<CalendarResult>;
  connectReminders: () => Promise<RemindersResult>;
}

interface FamilyHubBridge {
  assistant: AssistantBridge;
  dashboard: DashboardBridge;
  ping: () => Promise<string>;
}

interface Window {
  familyHub: FamilyHubBridge;
}
