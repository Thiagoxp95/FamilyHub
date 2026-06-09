import { BrowserWindow, ipcMain } from "electron";
import {
  loadCalendar,
  loadReminders,
  type CalendarResult,
  type RemindersResult,
} from "./eventkit";
import { createUserDataNotesStore } from "./notesStore";
import {
  isNoteColor,
  type Note,
  type NoteInput,
  type NotePatch,
} from "./notesTypes";
import { loadWeather, type WeatherSnapshot } from "./weather";

const weatherChannel = "dashboard:weather";
const calendarChannel = "dashboard:calendar";
const remindersChannel = "dashboard:reminders";
const notesChannel = "dashboard:notes";
const focusChannel = "dashboard:focus";
const reminderListChannel = "dashboard:reminderList";
const reminderCompletingChannel = "dashboard:reminderCompleting";
const weatherRefreshMs = 15 * 60 * 1000;
const eventkitRefreshMs = 5 * 60 * 1000;

export type DashboardPanel = "calendar" | "weather" | "reminders" | "notes" | null;

export type WeatherResult =
  | { ok: true; weather: WeatherSnapshot }
  | { ok: false; error: string };

export interface DashboardController {
  createNote: (input: NoteInput) => Promise<Note>;
  deleteNote: (id: string) => Promise<{ deleted: true; id: string }>;
  focusPanel: (panel: DashboardPanel) => void;
  // Select a specific Reminders list (by name) in the UI, e.g. when the
  // assistant is talking about the "To Buy" list. null clears the selection.
  focusReminderList: (list: string | null) => void;
  getNotes: () => Promise<Note[]>;
  getReminders: () => Promise<RemindersResult>;
  getWeather: () => Promise<WeatherResult>;
  // Announce (before the slow AppleScript mutation runs) that a reminder is being
  // completed, so the UI can optimistically strike it through and check it off.
  markReminderCompleting: (id: string) => void;
  refreshCalendar: () => Promise<void>;
  refreshNotes: () => Promise<void>;
  refreshReminders: () => Promise<void>;
  updateNote: (id: string, patch: NotePatch) => Promise<Note | null>;
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

export function registerDashboardIpc(userDataDirectory: string): DashboardController {
  const notesStore = createUserDataNotesStore(userDataDirectory);
  let weather: WeatherResult = { ok: false, error: "Loading weather…" };
  let calendar: CalendarResult = { status: "denied" };
  let reminders: RemindersResult = { status: "denied" };
  let notes: Note[] = [];
  let focusedPanel: DashboardPanel = null;
  let selectedReminderList: string | null = null;

  async function refreshWeather(): Promise<WeatherResult> {
    try {
      weather = { ok: true, weather: await loadWeather() };
    } catch (error) {
      weather = {
        ok: false,
        error: error instanceof Error ? error.message : "Weather unavailable.",
      };
    }

    broadcast(weatherChannel, weather);
    return weather;
  }

  // For the assistant: return cached weather, refreshing first if the last load
  // failed so a voice query doesn't get stuck on a stale error.
  async function getWeather(): Promise<WeatherResult> {
    return weather.ok ? weather : refreshWeather();
  }

  async function refreshCalendar(): Promise<void> {
    calendar = await loadCalendar();
    broadcast(calendarChannel, calendar);
  }

  async function refreshReminders(): Promise<void> {
    reminders = await loadReminders();
    broadcast(remindersChannel, reminders);
  }

  // For the assistant: serve the in-memory reminders (loaded in the background)
  // so a voice query is instant instead of triggering a fresh multi-second
  // AppleScript scan. Only fall back to a live load if the cache isn't ready yet.
  async function getReminders(): Promise<RemindersResult> {
    if (reminders.status !== "ok") {
      await refreshReminders();
    }
    return reminders;
  }

  async function refreshNotes(): Promise<void> {
    notes = await notesStore.getNotes();
    broadcast(notesChannel, notes);
  }

  function focusPanel(panel: DashboardPanel): void {
    focusedPanel = panel;
    broadcast(focusChannel, focusedPanel);
  }

  function focusReminderList(list: string | null): void {
    selectedReminderList = list && list.trim() ? list.trim() : null;
    broadcast(reminderListChannel, selectedReminderList);
  }

  function markReminderCompleting(id: string): void {
    if (id && id.trim()) {
      broadcast(reminderCompletingChannel, id.trim());
    }
  }

  async function createNote(input: NoteInput): Promise<Note> {
    // Idempotency: if a note with the same text already exists, return it
    // instead of creating a duplicate (Gemini sometimes repeats a create call).
    const wanted = input.text.trim().toLowerCase();
    const duplicate = (await notesStore.getNotes()).find(
      (note) => note.text.trim().toLowerCase() === wanted,
    );
    if (duplicate) {
      return duplicate;
    }

    const note = await notesStore.createNote(input);
    await refreshNotes();
    return note;
  }

  async function updateNote(id: string, patch: NotePatch): Promise<Note | null> {
    const note = await notesStore.updateNote(id, patch);
    await refreshNotes();
    return note;
  }

  async function deleteNote(id: string): Promise<{ deleted: true; id: string }> {
    const result = await notesStore.deleteNote(id);
    await refreshNotes();
    return result;
  }

  ipcMain.handle("dashboard:getWeather", () => weather);
  ipcMain.handle("dashboard:getCalendar", () => calendar);
  ipcMain.handle("dashboard:getReminders", () => reminders);
  ipcMain.handle("dashboard:getNotes", () => notes);
  ipcMain.handle("dashboard:getFocusedPanel", () => focusedPanel);
  ipcMain.handle("dashboard:getReminderList", () => selectedReminderList);

  // User-initiated (foreground) connect — this is what reliably triggers the
  // macOS EventKit permission prompt, since the request is then attributed to
  // FamilyHub while it is the focused app.
  ipcMain.handle("dashboard:connectCalendar", async () => {
    await refreshCalendar();
    return calendar;
  });
  ipcMain.handle("dashboard:connectReminders", async () => {
    await refreshReminders();
    return reminders;
  });

  ipcMain.handle("dashboard:createNote", async (_event, input: unknown) =>
    createNote(readNoteInput(input)),
  );
  ipcMain.handle(
    "dashboard:updateNote",
    async (_event, id: unknown, patch: unknown) =>
      updateNote(requireString(id, "Note id"), readNotePatch(patch)),
  );
  ipcMain.handle("dashboard:deleteNote", async (_event, id: unknown) =>
    deleteNote(requireString(id, "Note id")),
  );

  void refreshWeather();
  void refreshCalendar();
  void refreshReminders();
  void refreshNotes();

  setInterval(() => {
    void refreshWeather();
  }, weatherRefreshMs);
  setInterval(() => {
    void refreshCalendar();
    void refreshReminders();
  }, eventkitRefreshMs);

  // Exposed so the assistant can re-pull a card right after the agent writes to
  // Calendar/Reminders/Notes, instead of waiting for the periodic refresh.
  return {
    createNote,
    deleteNote,
    focusPanel,
    focusReminderList,
    getNotes: () => notesStore.getNotes(),
    getReminders,
    getWeather,
    markReminderCompleting,
    refreshCalendar,
    refreshNotes,
    refreshReminders,
    updateNote,
  };
}

function readNoteInput(value: unknown): NoteInput {
  if (!isRecord(value)) {
    throw new Error("Note input is required.");
  }

  const input: NoteInput = {
    text: requireString(value.text, "Note text"),
  };

  if (typeof value.emoji === "string" && value.emoji.trim()) {
    input.emoji = value.emoji.trim();
  }

  if (isNoteColor(value.color)) {
    input.color = value.color;
  }

  return input;
}

function readNotePatch(value: unknown): NotePatch {
  if (!isRecord(value)) {
    throw new Error("Note patch is required.");
  }

  const patch: NotePatch = {};

  if (typeof value.text === "string") {
    patch.text = value.text;
  }

  if (typeof value.emoji === "string" && value.emoji.trim()) {
    patch.emoji = value.emoji.trim();
  }

  if (isNoteColor(value.color)) {
    patch.color = value.color;
  }

  if (typeof value.x === "number" && Number.isFinite(value.x)) {
    patch.x = clamp01(value.x);
  }

  if (typeof value.y === "number" && Number.isFinite(value.y)) {
    patch.y = clamp01(value.y);
  }

  if (typeof value.rotation === "number" && Number.isFinite(value.rotation)) {
    patch.rotation = value.rotation;
  }

  return patch;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
