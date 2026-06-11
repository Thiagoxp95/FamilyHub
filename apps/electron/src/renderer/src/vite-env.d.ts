/// <reference types="vite/client" />

interface AssistantConfigStatus {
  gemini: boolean;
  googleSpeech: boolean;
  localListener: boolean;
}

interface AssistantEvent {
  at: string;
  message: string;
  type: "accepted" | "assistant" | "ignored" | "info" | "error";
}

interface AssistantSnapshot {
  config: AssistantConfigStatus;
  events: AssistantEvent[];
  isListening: boolean;
  lastAssistantResponse: string | null;
  lastTranscript: string | null;
  wakePhrase: string;
}

type LiveMode = "wake" | "connecting" | "live";

type LiveStateEvent =
  | { type: "mode"; mode: LiveMode }
  | { type: "inputTranscript"; text: string }
  | { type: "outputTranscript"; text: string }
  | { type: "status"; message: string }
  | { type: "listener"; state: "loading" | "ready" | "offline"; detail?: string }
  | { type: "localHeard"; text: string; phase: string }
  | { type: "interrupted" }
  | { type: "turnComplete" };

interface LiveAudioChunk {
  data: string;
  mimeType: string;
}

interface AssistantBridge {
  getSnapshot: () => Promise<AssistantSnapshot>;
  onSnapshot: (callback: (snapshot: AssistantSnapshot) => void) => () => void;
  startListening: () => Promise<AssistantSnapshot>;
  stopListening: () => Promise<AssistantSnapshot>;
  sendMicFrame: (frame: string) => void;
  endLive: () => Promise<boolean>;
  onLive: (callback: (event: LiveStateEvent) => void) => () => void;
  onLiveAudio: (callback: (chunk: LiveAudioChunk) => void) => () => void;
}

type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

interface UpdaterStatus {
  error?: string;
  percent?: number;
  state: UpdateState;
  version?: string;
}

interface UpdaterBridge {
  check: () => Promise<UpdaterStatus>;
  getStatus: () => Promise<UpdaterStatus>;
  install: () => Promise<UpdaterStatus>;
  onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
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

interface WeatherDay {
  condition: WeatherCondition;
  date: string;
  highC: number;
  humidity: number | null;
  lowC: number;
  precipitationChance: number | null;
  precipitationMm: number | null;
  sunrise: string | null;
  sunset: string | null;
  uvIndex: number | null;
  windMph: number | null;
}

interface WeatherSnapshot {
  apparentC: number;
  city: string | null;
  condition: WeatherCondition;
  forecast: WeatherDay[];
  highC: number;
  humidity: number | null;
  lowC: number;
  precipitationMm: number | null;
  temperatureC: number;
  updatedAt: string;
  uvIndex: number | null;
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
  id?: string;
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

type DashboardPanel = "calendar" | "weather" | "reminders" | "notes" | null;

type NoteColor = "yellow" | "pink" | "mint" | "blue" | "orange";

interface Note {
  id: string;
  text: string;
  emoji?: string;
  color: NoteColor;
  x: number;
  y: number;
  rotation: number;
  createdAt: number;
  updatedAt: number;
}

interface NoteInput {
  text: string;
  emoji?: string;
  color?: NoteColor;
}

interface NotePatch {
  text?: string;
  emoji?: string;
  color?: NoteColor;
  x?: number;
  y?: number;
  rotation?: number;
}

interface DashboardBridge {
  getWeather: () => Promise<WeatherResult>;
  onWeather: (callback: (result: WeatherResult) => void) => () => void;
  getCalendar: () => Promise<CalendarResult>;
  onCalendar: (callback: (result: CalendarResult) => void) => () => void;
  getReminders: () => Promise<RemindersResult>;
  onReminders: (callback: (result: RemindersResult) => void) => () => void;
  getNotes: () => Promise<Note[]>;
  onNotes: (callback: (notes: Note[]) => void) => () => void;
  getFocusedPanel: () => Promise<DashboardPanel>;
  onFocus: (callback: (panel: DashboardPanel) => void) => () => void;
  getReminderList: () => Promise<string | null>;
  onReminderList: (callback: (list: string | null) => void) => () => void;
  // Fires with a reminder id the moment the assistant starts completing it, so
  // the UI can optimistically strike it through before the mutation confirms.
  onReminderCompleting: (callback: (id: string) => void) => () => void;
  createNote: (input: NoteInput) => Promise<Note>;
  updateNote: (id: string, patch: NotePatch) => Promise<Note | null>;
  deleteNote: (id: string) => Promise<{ deleted: true; id: string }>;
  connectCalendar: () => Promise<CalendarResult>;
  connectReminders: () => Promise<RemindersResult>;
}

interface FamilyHubBridge {
  assistant: AssistantBridge;
  dashboard: DashboardBridge;
  updater: UpdaterBridge;
  ping: () => Promise<string>;
  getVersion: () => Promise<string>;
}

interface Window {
  familyHub: FamilyHubBridge;
}
