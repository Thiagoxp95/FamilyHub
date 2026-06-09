import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Calendar + Reminders for the dashboard via AppleScript (the macOS Automation
// permission), the same approach the Sentinel app uses successfully on this
// machine. EventKit's permission prompt can't be shown from a spawned helper;
// Automation prompts ("FamilyHub wants to control Calendar") are reliable.

const execFileAsync = promisify(execFile);

// ASCII Unit/Record separators — never appear in calendar/reminder text, so the
// AppleScript output needs no JSON/quote escaping.
export const US = String.fromCharCode(31);
export const RS = String.fromCharCode(30);

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
  // Apple Reminders id (x-apple-reminder://…). Carried so the assistant can act
  // on a specific item from cached data without a slow re-scan. Not shown in UI.
  id?: string;
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

export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// An AppleScript `date "..."` literal in the machine's local locale.
export function appleScriptDate(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const month = date.toLocaleDateString("en-US", { month: "long" });
  const day = date.getDate();
  const year = date.getFullYear();
  let hour = date.getHours();
  const minute = date.getMinutes().toString().padStart(2, "0");
  const second = date.getSeconds().toString().padStart(2, "0");
  const suffix = hour >= 12 ? "PM" : "AM";
  hour %= 12;
  if (hour === 0) {
    hour = 12;
  }
  return `date ${appleScriptString(
    `${weekday}, ${month} ${day}, ${year} at ${hour}:${minute}:${second} ${suffix}`,
  )}`;
}

// Local ISO formatter (no timezone) — Date.parse reads it back in local time.
export const isoHandlers = `
on pad(n)
  set n to n as integer
  if n < 10 then return "0" & (n as text)
  return n as text
end pad
on isoOf(d)
  return (year of d as text) & "-" & my pad(month of d as integer) & "-" & my pad(day of d) & "T" & my pad(hours of d) & ":" & my pad(minutes of d) & ":" & my pad(seconds of d)
end isoOf`;

function buildUpcomingCalendarScript(days: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1000);
  return `set US to (ASCII character 31)
set RS to (ASCII character 30)
set startDate to ${appleScriptDate(start)}
set endDate to ${appleScriptDate(end)}
set output to ""
tell application "Calendar"
  repeat with cal in calendars
    set calName to name of cal
    try
      set evs to (every event of cal whose start date >= startDate and start date < endDate)
      repeat with e in evs
        set output to output & (uid of e) & US & (summary of e) & US & my isoOf(start date of e) & US & my isoOf(end date of e) & US & ((allday event of e) as text) & US & calName & RS
      end repeat
    end try
  end repeat
end tell
return output
${isoHandlers}`;
}

function buildRemindersScript(): string {
  return `set US to (ASCII character 31)
set RS to (ASCII character 30)
set output to ""
tell application "Reminders"
  repeat with lst in lists
    set listName to name of lst
    try
      repeat with r in (reminders of lst whose completed is false)
        set dueText to ""
        try
          set dd to due date of r
          if dd is not missing value then set dueText to my isoOf(dd)
        end try
        set output to output & (id of r) & US & listName & US & (name of r) & US & dueText & RS
      end repeat
    end try
  end repeat
end tell
return output
${isoHandlers}`;
}

// -1743 / "Not authorized" is a genuine Automation denial → surface "denied".
export function isAuthError(message: string): boolean {
  return /not authoriz|not allowed|-1743|assistive/i.test(message);
}

// -600 "Application isn't running" is transient — the target app is just closed.
function isAppNotRunning(message: string): boolean {
  return /\(-600\)|application isn.?t running/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOsascript(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  } catch (err) {
    // execFile's error.message is just "Command failed: osascript -e <script>";
    // the actual osascript diagnostic ("Not authorized… (-1743)", "(-600)") is on
    // stderr. Re-throw with stderr as the message so isAuthError / isAppNotRunning
    // can classify it instead of the UI showing the raw command.
    const e = err as { stderr?: unknown; killed?: boolean; signal?: string };
    const stderr = e.stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      throw new Error(stderr.trim());
    }
    // No stderr means execFile killed the process at the timeout (SIGTERM) — a
    // slow Reminders/Calendar scan, not a real diagnostic. Never let the raw
    // "Command failed: osascript -e <script>" reach the UI; classify it cleanly.
    if (e.killed || e.signal === "SIGTERM") {
      throw new Error("timed out");
    }
    throw new Error("unavailable");
  }
}

// A timeout/empty-stderr failure → show a calm message, not the raw command.
export function isTimeoutError(message: string): boolean {
  return /timed out/i.test(message);
}

// Launch the target app hidden (-g: don't foreground, -j: launch hidden) so the
// kitchen display stays put while it comes up to answer Apple events.
async function launchAppHidden(appName: string): Promise<void> {
  await execFileAsync("open", ["-gj", "-a", appName]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await execFileAsync("pgrep", ["-x", appName]);
      return;
    } catch {
      await delay(250);
    }
  }
}

export async function runWithLaunch(script: string, appName: string): Promise<string> {
  try {
    return await runOsascript(script);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isAppNotRunning(message)) {
      throw err;
    }
    await launchAppHidden(appName);
    return await runOsascript(script);
  }
}

export async function loadCalendar(days = 14): Promise<CalendarResult> {
  try {
    const stdout = await runWithLaunch(
      buildUpcomingCalendarScript(days),
      "Calendar",
    );
    return { status: "ok", events: parseCalendar(stdout) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthError(message)) {
      return { status: "denied" };
    }
    return {
      status: "error",
      error: isTimeoutError(message)
        ? "Calendar is taking a while — it'll refresh shortly."
        : "Calendar is unavailable right now.",
    };
  }
}

export async function loadReminders(): Promise<RemindersResult> {
  try {
    const stdout = await runWithLaunch(buildRemindersScript(), "Reminders");
    return { status: "ok", lists: parseReminders(stdout) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthError(message)) {
      return { status: "denied" };
    }
    return {
      status: "error",
      error: isTimeoutError(message)
        ? "Reminders is taking a while — it'll refresh shortly."
        : "Reminders is unavailable right now.",
    };
  }
}

export function parseCalendar(raw: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const record of raw.split(RS)) {
    if (!record.trim()) {
      continue;
    }

    const fields = record.split(US);
    const title = fields[1];
    const start = fields[2];
    const end = fields[3];
    const allDay = fields[4];
    const calendar = fields[5];

    if (!start) {
      continue;
    }

    events.push({
      allDay: allDay === "true",
      calendar: calendar ?? "",
      end: end ?? start,
      start,
      title: title && title.trim() ? title : "(no title)",
    });
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}

export function parseReminders(raw: string): ReminderList[] {
  const order: string[] = [];
  const byList = new Map<string, ReminderItem[]>();

  for (const record of raw.split(RS)) {
    if (!record.trim()) {
      continue;
    }

    const fields = record.split(US);
    const id = fields[0];
    const rawName = fields[1];
    const title = fields[2];
    const due = fields[3];
    const name = rawName && rawName.trim() ? rawName : "Reminders";

    let items = byList.get(name);
    if (!items) {
      items = [];
      order.push(name);
      byList.set(name, items);
    }

    const item: ReminderItem = {
      title: title && title.trim() ? title : "(untitled)",
    };
    if (id && id.trim()) {
      item.id = id;
    }
    if (due && due.trim()) {
      item.due = due;
    }
    items.push(item);
  }

  return order.map((name) => ({ items: byList.get(name) ?? [], name }));
}
