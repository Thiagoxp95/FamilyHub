import { describe, expect, it } from "vitest";
import { parseCalendar, parseReminders } from "./eventkit";

const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

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
        start: "2026-06-05T09:00:00",
        title: "Standup",
      },
      {
        allDay: false,
        calendar: "Home",
        end: "2026-06-05T13:30:00",
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
        start: "2026-06-05T08:00:00",
        title: "(no title)",
      },
    ]);
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
