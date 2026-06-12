import { useEffect, useMemo, useState } from "react";

interface AgendaItem {
  at: number;
  allDay: boolean;
  kind: "event" | "reminder";
  sub: string;
  title: string;
}

interface AgendaGroup {
  items: AgendaItem[];
  key: string;
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_DAYS = 14;

export function CalendarPanel(): React.JSX.Element {
  const [calendar, setCalendar] = useState<CalendarResult | null>(null);
  const [reminders, setReminders] = useState<RemindersResult | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    window.familyHub.dashboard
      .getCalendar()
      .then(setCalendar)
      .catch(() => setCalendar({ status: "error", error: "Calendar unavailable." }));
    window.familyHub.dashboard
      .getReminders()
      .then(setReminders)
      .catch(() => undefined);

    const offCalendar = window.familyHub.dashboard.onCalendar(setCalendar);
    const offReminders = window.familyHub.dashboard.onReminders(setReminders);
    return () => {
      offCalendar();
      offReminders();
    };
  }, []);

  function connect(): void {
    setConnecting(true);
    window.familyHub.dashboard
      .connectCalendar()
      .then(setCalendar)
      .catch(() => setCalendar({ status: "error", error: "Calendar unavailable." }))
      .finally(() => setConnecting(false));
  }

  const groups = useMemo(
    () => buildAgenda(calendar, reminders),
    [calendar, reminders],
  );

  if (!calendar || calendar.status === "loading") {
    return <p className="quad-placeholder">Loading calendar…</p>;
  }

  if (calendar.status !== "ok") {
    const message =
      calendar.status === "writeOnly"
        ? "Calendar is set to “Add Events Only.” Click below and choose Allow Full Access."
        : calendar.status === "error"
          ? calendar.error
          : "FamilyHub needs access to your Calendar.";

    return (
      <div className="connect-state">
        <p className="quad-placeholder">{message}</p>
        <button
          className="connect-btn"
          disabled={connecting}
          onClick={connect}
          type="button"
        >
          {connecting ? "Waiting for permission…" : "Connect Calendar"}
        </button>
      </div>
    );
  }

  if (groups.length === 0) {
    return <p className="quad-placeholder">Nothing coming up in the next two weeks.</p>;
  }

  return (
    <div className="cal-agenda">
      {groups.map((group) => (
        <div className="cal-day" key={group.key}>
          <p className="cal-day-head">{group.label}</p>
          <ul className="cal-day-list">
            {group.items.map((item, index) => (
              <li
                className={`cal-item cal-item--${item.kind}`}
                key={`${item.at}-${item.title}-${index}`}
              >
                <span className="cal-time">
                  {item.kind === "reminder"
                    ? "Due"
                    : item.allDay
                      ? "All day"
                      : formatTime(item.at)}
                </span>
                <span className="cal-event-main">
                  <span className="cal-title">{item.title}</span>
                  {item.sub ? <span className="cal-cal">{item.sub}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function buildAgenda(
  calendar: CalendarResult | null,
  reminders: RemindersResult | null,
): AgendaGroup[] {
  const startOfToday = startOfDay(Date.now());
  const horizonEnd = startOfToday + HORIZON_DAYS * DAY_MS;
  const items: AgendaItem[] = [];

  if (calendar && calendar.status === "ok") {
    for (const event of calendar.events) {
      const at = Date.parse(event.start);
      if (!Number.isFinite(at) || at < startOfToday || at >= horizonEnd) {
        continue;
      }
      items.push({
        at,
        allDay: event.allDay,
        kind: "event",
        sub: event.calendar,
        title: event.title,
      });
    }
  }

  if (reminders && reminders.status === "ok") {
    for (const list of reminders.lists) {
      for (const reminder of list.items) {
        if (!reminder.due) {
          continue;
        }
        const at = Date.parse(reminder.due);
        // Include overdue (before today) too; just not beyond the horizon.
        if (!Number.isFinite(at) || at >= horizonEnd) {
          continue;
        }
        items.push({
          at,
          allDay: false,
          kind: "reminder",
          sub: list.name,
          title: reminder.title,
        });
      }
    }
  }

  const buckets = new Map<
    string,
    { items: AgendaItem[]; label: string; sort: number }
  >();

  for (const item of items) {
    const overdue = item.kind === "reminder" && item.at < startOfToday;
    const key = overdue ? "overdue" : dayKey(item.at);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        items: [],
        label: overdue ? "Overdue" : dayLabel(item.at, startOfToday),
        sort: overdue ? -1 : startOfDay(item.at),
      };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[1].sort - b[1].sort)
    .map(([key, bucket]) => {
      bucket.items.sort((x, y) => {
        if (x.allDay !== y.allDay) {
          return x.allDay ? -1 : 1;
        }
        return x.at - y.at;
      });
      return { items: bucket.items, key, label: bucket.label };
    });
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(ms: number, startOfToday: number): string {
  const diff = Math.round((startOfDay(ms) - startOfToday) / DAY_MS);
  if (diff === 0) {
    return "Today";
  }
  if (diff === 1) {
    return "Tomorrow";
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    weekday: "short",
  }).format(new Date(ms));
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
