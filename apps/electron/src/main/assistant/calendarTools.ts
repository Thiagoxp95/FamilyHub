// Agent-facing Calendar + Reminders operations: id-aware reads plus
// create/update/delete, via AppleScript — reusing the dashboard's osascript
// helpers. Kept separate from eventkit.ts (the read-only dashboard layer) so the
// dashboard's shapes and tests stay stable. Event uid / reminder id let the
// agent target a specific item for update / complete / delete.

import {
  RS,
  US,
  appleScriptDate,
  appleScriptString,
  isoHandlers,
  runWithLaunch,
} from "../dashboard/eventkit";

export interface AgentEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
}

export interface AgentReminder {
  id: string;
  title: string;
  due?: string;
  list: string;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end?: string | undefined;
  allDay?: boolean | undefined;
  calendar?: string | undefined;
  alarmsMinutesBefore?: number[] | undefined;
}

export interface UpdateEventInput {
  id: string;
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  allDay?: boolean | undefined;
  alarmsMinutesBefore?: number[] | undefined;
}

export interface CreateReminderInput {
  title: string;
  due?: string | undefined;
  list?: string | undefined;
  notes?: string | undefined;
}

function parseDate(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date/time: "${iso}". Use ISO local time, e.g. 2026-06-09T15:00:00.`);
  }
  return date;
}

// Calendar display alarms: trigger interval is minutes relative to the event,
// negative = before.
function alarmLines(minutes: number[] | undefined, target: string): string {
  if (!minutes || minutes.length === 0) {
    return "";
  }
  return minutes
    .map(
      (m) =>
        `  make new display alarm at end of display alarms of ${target} with properties {trigger interval:${-Math.round(Math.abs(m))}}`,
    )
    .join("\n");
}

function calendarSelector(name?: string): string {
  return name && name.trim()
    ? `(first calendar whose name is ${appleScriptString(name.trim())})`
    : "(first calendar whose writable is true)";
}

// ---------- reads (with ids) ----------

export async function listEvents(daysAhead = 14): Promise<AgentEvent[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + Math.max(1, daysAhead) * 86_400_000);
  const script = `set US to (ASCII character 31)
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
  const stdout = await runWithLaunch(script, "Calendar");
  const events: AgentEvent[] = [];
  for (const record of stdout.split(RS)) {
    if (!record.trim()) {
      continue;
    }
    const f = record.split(US);
    if (!f[2]) {
      continue;
    }
    events.push({
      id: f[0] ?? "",
      title: f[1] && f[1].trim() ? f[1] : "(no title)",
      start: f[2],
      end: f[3] ?? f[2],
      allDay: f[4] === "true",
      calendar: f[5] ?? "",
    });
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}

export async function listReminders(): Promise<AgentReminder[]> {
  const script = `set US to (ASCII character 31)
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
  const stdout = await runWithLaunch(script, "Reminders");
  const reminders: AgentReminder[] = [];
  for (const record of stdout.split(RS)) {
    if (!record.trim()) {
      continue;
    }
    const f = record.split(US);
    const reminder: AgentReminder = {
      id: f[0] ?? "",
      list: f[1] && f[1].trim() ? f[1] : "Reminders",
      title: f[2] && f[2].trim() ? f[2] : "(untitled)",
    };
    if (f[3] && f[3].trim()) {
      reminder.due = f[3];
    }
    reminders.push(reminder);
  }
  return reminders;
}

// ---------- calendar writes ----------

export async function createEvent(input: CreateEventInput): Promise<AgentEvent> {
  const startDate = parseDate(input.start);
  const allDay = input.allDay === true;
  const endDate = input.end
    ? parseDate(input.end)
    : new Date(startDate.getTime() + (allDay ? 86_400_000 : 3_600_000));
  const script = `set US to (ASCII character 31)
tell application "Calendar"
  set theCal to ${calendarSelector(input.calendar)}
  set newEvent to make new event at end of events of theCal with properties {summary:${appleScriptString(
    input.title,
  )}, start date:${appleScriptDate(startDate)}, end date:${appleScriptDate(
    endDate,
  )}, allday event:${allDay ? "true" : "false"}}
${alarmLines(input.alarmsMinutesBefore, "newEvent")}
  set theUid to uid of newEvent
  set theName to name of theCal
end tell
return theUid & US & theName`;
  const stdout = await runWithLaunch(script, "Calendar");
  const [uid, calName] = stdout.trim().split(US);
  return {
    id: uid ?? "",
    title: input.title,
    start: input.start,
    end: input.end ?? endDate.toISOString(),
    allDay,
    calendar: calName ?? input.calendar ?? "",
  };
}

export async function updateEvent(input: UpdateEventInput): Promise<void> {
  const sets: string[] = [];
  if (input.title !== undefined) {
    sets.push(`set summary of theEvent to ${appleScriptString(input.title)}`);
  }
  if (input.start !== undefined) {
    sets.push(`set start date of theEvent to ${appleScriptDate(parseDate(input.start))}`);
  }
  if (input.end !== undefined) {
    sets.push(`set end date of theEvent to ${appleScriptDate(parseDate(input.end))}`);
  }
  if (input.allDay !== undefined) {
    sets.push(`set allday event of theEvent to ${input.allDay ? "true" : "false"}`);
  }

  const alarmBlock =
    input.alarmsMinutesBefore !== undefined
      ? `delete (every display alarm of theEvent)\n${alarmLines(
          input.alarmsMinutesBefore,
          "theEvent",
        )}`
      : "";

  const script = `tell application "Calendar"
  set theEvent to missing value
  repeat with cal in calendars
    try
      set theEvent to (first event of cal whose uid is ${appleScriptString(input.id)})
      exit repeat
    end try
  end repeat
  if theEvent is missing value then error "Event not found"
  ${sets.join("\n  ")}
  ${alarmBlock}
end tell
return "ok"`;
  await runWithLaunch(script, "Calendar");
}

export async function deleteEvent(id: string): Promise<void> {
  const script = `tell application "Calendar"
  repeat with cal in calendars
    try
      delete (every event of cal whose uid is ${appleScriptString(id)})
    end try
  end repeat
end tell
return "ok"`;
  await runWithLaunch(script, "Calendar");
}

// ---------- reminder writes ----------

export async function createReminder(input: CreateReminderInput): Promise<{ list: string }> {
  const props = [`name:${appleScriptString(input.title)}`];
  if (input.due) {
    props.push(`due date:${appleScriptDate(parseDate(input.due))}`);
  }
  if (input.notes) {
    props.push(`body:${appleScriptString(input.notes)}`);
  }
  const listSelector =
    input.list && input.list.trim()
      ? `(first list whose name is ${appleScriptString(input.list.trim())})`
      : "default list";
  const script = `tell application "Reminders"
  set theList to ${listSelector}
  tell theList to make new reminder with properties {${props.join(", ")}}
  set theName to name of theList
end tell
return theName`;
  const stdout = await runWithLaunch(script, "Reminders");
  return { list: stdout.trim() || input.list || "Reminders" };
}

async function findReminderAndRun(id: string, action: string): Promise<void> {
  const script = `tell application "Reminders"
  set wasFound to false
  repeat with lst in lists
    try
      set r to (first reminder of lst whose id is ${appleScriptString(id)})
      ${action}
      set wasFound to true
      exit repeat
    end try
  end repeat
  if not wasFound then error "Reminder not found"
end tell
return "ok"`;
  await runWithLaunch(script, "Reminders");
}

export async function completeReminder(id: string): Promise<void> {
  await findReminderAndRun(id, "set completed of r to true");
}

export async function deleteReminder(id: string): Promise<void> {
  await findReminderAndRun(id, "delete r");
}
