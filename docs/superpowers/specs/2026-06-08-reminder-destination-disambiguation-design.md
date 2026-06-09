# Reminder destination disambiguation + `update_reminder`

**Date:** 2026-06-08
**Area:** `apps/electron/src/main/assistant` (Gemini Live voice assistant "James")

## Problem

When a family member asks James to "make a reminder," the word is ambiguous: it
could mean an item in the Apple **Reminders app** (a checklist entry) or a
**Calendar** entry (a timed event with an alert). Today James has no guidance to
disambiguate, so he silently picks `create_reminder` (Reminders app) and may put
the item in the wrong place.

The user wants James to **ask where** before creating — unless the user already
made the destination clear — and to support create **and** update on both
destinations.

## Current state (already exists)

- **Reminders app**: `create_reminder`, `complete_reminder`, `delete_reminder`
  (`calendarTools.ts`, dispatched in `ipc.ts`). No way to *edit* an existing
  item's title/due/notes.
- **Calendar**: `create_event`, `update_event`, `delete_event` — full CRUD,
  including `alarmsMinutesBefore`.

So both destinations exist; the only structural gap is editing a Reminders-app
item. The behavioral gap (disambiguation) is purely prompt-level.

## Decisions (from brainstorming)

1. **"Calendar reminder" = a timed event with an alarm at the event time.**
   Implemented by calling `create_event` with `alarmsMinutesBefore: [0]`
   (`alarmLines` already maps `0` to a trigger interval of `0` = at start).
2. **Ask only when there is no destination cue.** James routes directly — no
   question — when the user gives a natural cue:
   - names a Reminders list ("add milk to the **shopping list**") → Reminders app
   - says "calendar" / "event" / "appointment" → Calendar event
   Otherwise (a bare "remind me" / "make a reminder" with no place), James asks
   once: *"On your calendar, or in the Reminders app?"* then routes.
3. **Add `update_reminder`** for true parity with `update_event`.

## Changes

### A. Behavior — `liveSession.ts`

1. **`defaultSystemInstruction`** (line ~37): append a short rule:
   > A "reminder" can live in two places: the **Reminders app** (a checklist
   > item) or the **Calendar** (a timed event with an alert). If the user asks to
   > be reminded or to create a reminder without indicating which, ask "On your
   > calendar, or in the Reminders app?" before creating. Skip the question and
   > route directly when they give a cue — naming a reminders list means the
   > Reminders app; saying "calendar", "event", or "appointment" means the
   > Calendar. For a calendar reminder, create a timed event with an alarm at the
   > event time (`create_event` with `alarmsMinutesBefore` of `[0]`).
2. **`create_reminder` description** (line ~203): clarify it targets the Apple
   **Reminders app** checklist, and that if the destination is unclear James
   should first ask calendar vs. Reminders app.
3. **`create_event` description** (line ~116): note it is also how to make a
   "calendar reminder" — a timed event; pass `alarmsMinutesBefore: [0]` for an
   alert at the start time.
4. Add **`updateReminder: "update_reminder"`** to `calendarToolNames` and a new
   function declaration: params `id` (required, from `list_reminders`), optional
   `title`, `due`, `notes`. Description notes only provided fields change and to
   confirm before overwriting.

### B. New write — `calendarTools.ts`

Add `UpdateReminderInput { id: string; title?; due?; notes? }` and
`updateReminder(input)`. Address the item directly by id (reuse the
`reminder id <id>` pattern from `runOnReminder` — avoids the slow whole-list
scan), setting only the provided properties:

- `title` → `set name of r to <string>`
- `due` → `set due date of r to <date>`
- `notes` → `set body of r to <string>`

If no fields are provided, it's a no-op (return without running AppleScript).
Reuse existing `appleScriptString` / `appleScriptDate` / `parseDate` helpers.

### C. Dispatch — `ipc.ts`

Add `case calendarToolNames.updateReminder` mirroring `updateEvent`:
focus the reminders panel, call `calendarTools.updateReminder({...})` with
`optStr`-guarded args, `void dashboard?.refreshReminders()`, return `{ ok: true }`.

### D. Tests — `calendarTools.test.ts`

Follow the existing pattern (the suite mocks the AppleScript runner). Add cases:
- `updateReminder` emits `set name` / `set due date` / `set body` only for the
  provided fields, and addresses the item via `reminder id`.
- `updateReminder` with no fields runs no script (no-op).

## Non-goals (YAGNI)

- No general "smart reminder" router tool — disambiguation stays in the prompt so
  James asks the human, which is the desired UX.
- No change to the read path (`list_reminders` / `list_events`) — reads are out
  of scope.
- No clearing of a due date via `update_reminder` (only setting). Can be added
  later if needed.

## Acceptance

- "James, remind me to call the dentist" (no place) → James asks calendar vs.
  Reminders app, then creates in the chosen place.
- "James, add milk to the shopping list" → goes straight to the Reminders app,
  no question.
- "James, put 'pay rent at 9am' on my calendar" → `create_event` timed at 9am
  with `alarmsMinutesBefore: [0]`, no question.
- "James, change the dentist reminder to 4pm" → `update_reminder` edits the due
  date by id.
- `npm test` / typecheck pass for the touched package.
