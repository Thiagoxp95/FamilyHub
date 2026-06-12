import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEvent,
  isSameEvent,
  isSameReminder,
  listEvents,
  updateReminder,
  type AgentEvent,
  type AgentReminder,
} from "./calendarTools";

const appleScriptDateMock = vi.hoisted(() =>
  vi.fn((date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `date "${year}-${month}-${day}T${hour}:${minute}:${second}"`;
  }),
);
const runWithLaunchMock = vi.hoisted(() => vi.fn(async () => ""));

vi.mock("../dashboard/eventkit", () => ({
  RS: String.fromCharCode(30),
  US: String.fromCharCode(31),
  appleScriptDate: appleScriptDateMock,
  appleScriptString: (value: string) => `"${value}"`,
  isoHandlers: "",
  runWithLaunch: runWithLaunchMock,
}));

describe("listEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 7, 12, 0, 0));
    appleScriptDateMock.mockClear();
    runWithLaunchMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes the full requested future day", async () => {
    await listEvents(2);

    const startDate = appleScriptDateMock.mock.calls[0]?.[0];
    const endDate = appleScriptDateMock.mock.calls[1]?.[0];

    expect(localIso(startDate)).toBe("2026-06-07T00:00:00");
    expect(localIso(endDate)).toBe("2026-06-10T00:00:00");
  });
});

const baseEvent: AgentEvent = {
  id: "uid-1",
  title: "Daily Dev",
  start: "2026-06-09T09:00:00",
  end: "2026-06-09T10:00:00",
  allDay: false,
  calendar: "Calendar",
};

describe("isSameEvent (create idempotency)", () => {
  it("matches the same title and start (duplicate create)", () => {
    expect(
      isSameEvent(baseEvent, { title: "Daily Dev", start: "2026-06-09T09:00:00" }),
    ).toBe(true);
  });

  it("ignores case and surrounding whitespace in the title", () => {
    expect(
      isSameEvent(baseEvent, { title: "  daily   dev ", start: "2026-06-09T09:00:00" }),
    ).toBe(true);
  });

  it("tolerates sub-minute start differences", () => {
    expect(
      isSameEvent(baseEvent, { title: "Daily Dev", start: "2026-06-09T09:00:30" }),
    ).toBe(true);
  });

  it("does not match a different title or start", () => {
    expect(
      isSameEvent(baseEvent, { title: "Standup", start: "2026-06-09T09:00:00" }),
    ).toBe(false);
    expect(
      isSameEvent(baseEvent, { title: "Daily Dev", start: "2026-06-09T10:00:00" }),
    ).toBe(false);
  });

  it("does not match when the all-day flag differs", () => {
    expect(
      isSameEvent(baseEvent, {
        title: "Daily Dev",
        start: "2026-06-09T09:00:00",
        allDay: true,
      }),
    ).toBe(false);
  });

  it("requires the same calendar only when one is specified", () => {
    expect(
      isSameEvent(baseEvent, {
        title: "Daily Dev",
        start: "2026-06-09T09:00:00",
        calendar: "Work",
      }),
    ).toBe(false);
    expect(
      isSameEvent(baseEvent, {
        title: "Daily Dev",
        start: "2026-06-09T09:00:00",
        calendar: "Calendar",
      }),
    ).toBe(true);
  });
});

describe("createEvent with a cached snapshot", () => {
  beforeEach(() => {
    runWithLaunchMock.mockClear();
  });

  it("returns the cached duplicate without any AppleScript call", async () => {
    const event = await createEvent(
      { title: "Daily Dev", start: "2026-06-09T09:00:00" },
      [baseEvent],
    );

    expect(event).toBe(baseEvent);
    expect(runWithLaunchMock).not.toHaveBeenCalled();
  });

  it("skips the slow live pre-scan when a snapshot is provided", async () => {
    runWithLaunchMock.mockResolvedValueOnce(
      `uid-9${String.fromCharCode(31)}Calendar`,
    );

    await createEvent({ title: "Dentist", start: "2026-06-09T15:00:00" }, []);

    // Exactly one osascript run: the create itself, no listEvents pre-scan.
    expect(runWithLaunchMock).toHaveBeenCalledTimes(1);
    const calls = runWithLaunchMock.mock.calls as unknown as [string, string][];
    const script: string = calls[0]?.[0] ?? "";
    expect(script).toContain("make new event");
  });
});

const baseReminder: AgentReminder = {
  id: "rem-1",
  title: "Buy milk",
  list: "To Buy",
};

describe("isSameReminder (create idempotency)", () => {
  it("matches the same title (case-insensitive)", () => {
    expect(isSameReminder(baseReminder, { title: "buy milk" })).toBe(true);
  });

  it("does not match a different title", () => {
    expect(isSameReminder(baseReminder, { title: "Buy bread" })).toBe(false);
  });

  it("requires the same list only when one is specified", () => {
    expect(isSameReminder(baseReminder, { title: "Buy milk", list: "Brasil" })).toBe(
      false,
    );
    expect(isSameReminder(baseReminder, { title: "Buy milk", list: "To Buy" })).toBe(
      true,
    );
  });
});

describe("updateReminder", () => {
  beforeEach(() => {
    appleScriptDateMock.mockClear();
    runWithLaunchMock.mockClear();
  });

  it("sets only the provided fields (title only)", async () => {
    await updateReminder({ id: "rem-1", title: "Call dentist" });

    const calls = runWithLaunchMock.mock.calls as unknown as [string, string][];
    const script: string = calls[0]?.[0] ?? "";
    expect(script).toContain('reminder id "rem-1"');
    expect(script).toContain('set name of r to "Call dentist"');
    expect(script).not.toContain("set due date");
    expect(script).not.toContain("set body");
  });

  it("sets due date when provided and invokes appleScriptDateMock", async () => {
    await updateReminder({ id: "rem-2", due: "2026-07-01T09:00:00" });

    expect(appleScriptDateMock).toHaveBeenCalledOnce();
    const calls = runWithLaunchMock.mock.calls as unknown as [string, string][];
    const script: string = calls[0]?.[0] ?? "";
    expect(script).toContain("set due date of r to");
    expect(script).not.toContain("set name");
    expect(script).not.toContain("set body");
  });

  it("sets notes (body) when provided", async () => {
    await updateReminder({ id: "rem-3", notes: "Bring passport" });

    const calls = runWithLaunchMock.mock.calls as unknown as [string, string][];
    const script: string = calls[0]?.[0] ?? "";
    expect(script).toContain('set body of r to "Bring passport"');
    expect(script).not.toContain("set name");
    expect(script).not.toContain("set due date");
  });

  it("sets multiple fields on separate AppleScript lines", async () => {
    await updateReminder({ id: "rem-1", title: "Call dentist", notes: "office line" });

    const calls = runWithLaunchMock.mock.calls as unknown as [string, string][];
    const script: string = calls[0]?.[0] ?? "";
    const lines = script.split("\n");
    expect(lines.some((l) => l.includes('set name of r to "Call dentist"'))).toBe(true);
    expect(lines.some((l) => l.includes('set body of r to "office line"'))).toBe(true);
    // The two set-statements must be on distinct lines (not collapsed into one).
    const nameLine = lines.findIndex((l) => l.includes('set name of r to "Call dentist"'));
    const bodyLine = lines.findIndex((l) => l.includes('set body of r to "office line"'));
    expect(nameLine).not.toBe(bodyLine);
  });

  it("does not call runWithLaunch when no fields are provided (no-op)", async () => {
    await updateReminder({ id: "rem-1" });

    expect(runWithLaunchMock).not.toHaveBeenCalled();
  });
});

function localIso(date: Date | undefined): string {
  if (!date) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}
