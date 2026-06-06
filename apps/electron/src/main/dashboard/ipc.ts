import { BrowserWindow, ipcMain } from "electron";
import {
  loadCalendar,
  loadReminders,
  type CalendarResult,
  type RemindersResult,
} from "./eventkit";
import { loadWeather, type WeatherSnapshot } from "./weather";

const weatherChannel = "dashboard:weather";
const calendarChannel = "dashboard:calendar";
const remindersChannel = "dashboard:reminders";
const weatherRefreshMs = 15 * 60 * 1000;
const eventkitRefreshMs = 5 * 60 * 1000;

export type WeatherResult =
  | { ok: true; weather: WeatherSnapshot }
  | { ok: false; error: string };

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

export function registerDashboardIpc(): void {
  let weather: WeatherResult = { ok: false, error: "Loading weather…" };
  let calendar: CalendarResult = { status: "denied" };
  let reminders: RemindersResult = { status: "denied" };

  async function refreshWeather(): Promise<void> {
    try {
      weather = { ok: true, weather: await loadWeather() };
    } catch (error) {
      weather = {
        ok: false,
        error: error instanceof Error ? error.message : "Weather unavailable.",
      };
    }

    broadcast(weatherChannel, weather);
  }

  async function refreshCalendar(): Promise<void> {
    calendar = await loadCalendar();
    broadcast(calendarChannel, calendar);
  }

  async function refreshReminders(): Promise<void> {
    reminders = await loadReminders();
    broadcast(remindersChannel, reminders);
  }

  ipcMain.handle("dashboard:getWeather", () => weather);
  ipcMain.handle("dashboard:getCalendar", () => calendar);
  ipcMain.handle("dashboard:getReminders", () => reminders);

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

  void refreshWeather();
  void refreshCalendar();
  void refreshReminders();

  setInterval(() => {
    void refreshWeather();
  }, weatherRefreshMs);
  setInterval(() => {
    void refreshCalendar();
    void refreshReminders();
  }, eventkitRefreshMs);
}
