import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { app } from "electron";

const execFileAsync = promisify(execFile);
const currentDir = dirname(fileURLToPath(import.meta.url));

export interface CalendarEvent {
  allDay: boolean;
  calendar: string;
  end: string;
  start: string;
  title: string;
}

export type CalendarResult =
  | { status: "ok"; events: CalendarEvent[] }
  | { status: "writeOnly" }
  | { status: "denied" }
  | { status: "error"; error: string };

export interface ReminderItem {
  due?: string;
  title: string;
}

export interface ReminderList {
  items: ReminderItem[];
  name: string;
}

export type RemindersResult =
  | { status: "ok"; lists: ReminderList[] }
  | { status: "denied" }
  | { status: "error"; error: string };

function helperPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "fh-eventkit");
  }

  // Dev: compiled binary lives at apps/electron/resources/fh-eventkit, and the
  // bundled main runs from apps/electron/out/main.
  return join(currentDir, "../../resources/fh-eventkit");
}

async function runHelper(mode: "events" | "reminders"): Promise<unknown> {
  const { stdout } = await execFileAsync(helperPath(), [mode], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });

  return JSON.parse(stdout.trim());
}

function readStatus(data: unknown): string {
  if (data && typeof data === "object" && "status" in data) {
    const status = (data as { status: unknown }).status;
    return typeof status === "string" ? status : "error";
  }

  return "error";
}

export async function loadCalendar(): Promise<CalendarResult> {
  try {
    const data = await runHelper("events");
    const status = readStatus(data);

    if (status === "ok") {
      const events = (data as { events?: CalendarEvent[] }).events ?? [];
      return { status: "ok", events };
    }

    if (status === "writeOnly") {
      return { status: "writeOnly" };
    }

    return { status: "denied" };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Calendar helper failed.",
    };
  }
}

export async function loadReminders(): Promise<RemindersResult> {
  try {
    const data = await runHelper("reminders");
    const status = readStatus(data);

    if (status === "ok") {
      const lists = (data as { lists?: ReminderList[] }).lists ?? [];
      return { status: "ok", lists };
    }

    return { status: "denied" };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Reminders helper failed.",
    };
  }
}
