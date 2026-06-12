import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAuthError,
  keepLastGood,
  loadReminders,
  parseCalendar,
  parseReminders,
  type RemindersResult,
} from "./eventkit";

const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

// osascript reports failures (e.g. an Automation denial) on stderr, while
// execFile's rejection message is only "Command failed: <cmd>". Mock execFile so
// it rejects with the real diagnostic on `.stderr`, mirroring the OS.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

function rejectWithStderr(stderr: string): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) => {
      const error = new Error("Command failed: osascript -e <script>");
      (error as Error & { stderr: string }).stderr = stderr;
      cb(error);
    },
  );
}

// execFile kills osascript at the timeout with SIGTERM and no stderr — the
// failure mode that used to leak the raw "Command failed: osascript -e …" script
// straight to the kitchen panel.
function rejectAsTimeout(): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) => {
      const error = new Error("Command failed: osascript -e <script>");
      Object.assign(error, { killed: true, signal: "SIGTERM", stderr: "" });
      cb(error);
    },
  );
}

describe("parseCalendar", () => {
  it("parses US/RS-delimited events and sorts by start", () => {
    const raw =
      ["uid2", "Lunch", "2026-06-05T12:30:00", "2026-06-05T13:30:00", "false", "Home"].join(US) +
      RS +
      ["uid1", "Standup", "2026-06-05T09:00:00", "2026-06-05T09:15:00", "false", "Work"].join(US) +
      RS;

    expect(parseCalendar(raw)).toEqual([
      {
        allDay: false,
        calendar: "Work",
        end: "2026-06-05T09:15:00",
        id: "uid1",
        start: "2026-06-05T09:00:00",
        title: "Standup",
      },
      {
        allDay: false,
        calendar: "Home",
        end: "2026-06-05T13:30:00",
        id: "uid2",
        start: "2026-06-05T12:30:00",
        title: "Lunch",
      },
    ]);
  });

  it("skips records without a start and defaults a blank title", () => {
    const raw =
      ["u", "", "2026-06-05T08:00:00", "2026-06-05T08:30:00", "true", "Home"].join(US) + RS;
    expect(parseCalendar(raw)).toEqual([
      {
        allDay: true,
        calendar: "Home",
        end: "2026-06-05T08:30:00",
        id: "u",
        start: "2026-06-05T08:00:00",
        title: "(no title)",
      },
    ]);
  });
});

describe("keepLastGood", () => {
  const good: RemindersResult = {
    status: "ok",
    lists: [{ name: "To Buy", items: [{ title: "Milk" }] }],
  };

  it("keeps the previous ok data when a refresh errors", () => {
    expect(
      keepLastGood<RemindersResult>(good, { status: "error", error: "timed out" }),
    ).toBe(good);
  });

  it("replaces ok data on a genuine permission change", () => {
    expect(keepLastGood<RemindersResult>(good, { status: "denied" })).toEqual({
      status: "denied",
    });
  });

  it("lets an error through when there is no good data yet", () => {
    expect(
      keepLastGood<RemindersResult>(
        { status: "loading" },
        { status: "error", error: "unavailable" },
      ),
    ).toEqual({ status: "error", error: "unavailable" });
  });

  it("always accepts fresh ok data", () => {
    const fresh: RemindersResult = { status: "ok", lists: [] };
    expect(keepLastGood<RemindersResult>(good, fresh)).toBe(fresh);
  });
});

describe("loadReminders authorization", () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it("classifies an Automation denial (-1743) as denied, not a raw error", async () => {
    rejectWithStderr(
      'execution error: Not authorized to send Apple events to Reminders. (-1743)',
    );
    expect(await loadReminders()).toEqual({ status: "denied" });
  });

  it("isAuthError matches the -1743 stderr text", () => {
    expect(
      isAuthError("Not authorized to send Apple events to Reminders. (-1743)"),
    ).toBe(true);
    expect(isAuthError("some unrelated failure")).toBe(false);
  });

  it("never surfaces the raw command when osascript times out", async () => {
    rejectAsTimeout();
    const result = await loadReminders();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).not.toMatch(/osascript|Command failed/i);
      expect(result.error).toMatch(/taking a while/i);
    }
  });
});

describe("parseReminders", () => {
  it("groups items by list in first-seen order, carrying ids and due dates", () => {
    const raw =
      ["rem-1", "House Chores", "Buy milk", ""].join(US) +
      RS +
      ["rem-2", "To Buy", "Toothpaste", "2026-06-10T04:00:00"].join(US) +
      RS +
      ["rem-3", "House Chores", "Call plumber", ""].join(US) +
      RS;

    expect(parseReminders(raw)).toEqual([
      {
        name: "House Chores",
        items: [
          { id: "rem-1", title: "Buy milk" },
          { id: "rem-3", title: "Call plumber" },
        ],
      },
      {
        name: "To Buy",
        items: [{ id: "rem-2", title: "Toothpaste", due: "2026-06-10T04:00:00" }],
      },
    ]);
  });
});
