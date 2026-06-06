import { useEffect, useState } from "react";

export function CalendarPanel(): React.JSX.Element {
  const [result, setResult] = useState<CalendarResult | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    window.familyHub.dashboard
      .getCalendar()
      .then(setResult)
      .catch(() => setResult({ status: "error", error: "Calendar unavailable." }));

    return window.familyHub.dashboard.onCalendar(setResult);
  }, []);

  function connect(): void {
    setConnecting(true);
    window.familyHub.dashboard
      .connectCalendar()
      .then(setResult)
      .catch(() => setResult({ status: "error", error: "Calendar unavailable." }))
      .finally(() => setConnecting(false));
  }

  if (!result) {
    return <p className="quad-placeholder">Loading calendar…</p>;
  }

  if (result.status !== "ok") {
    const message =
      result.status === "writeOnly"
        ? "Calendar is set to “Add Events Only.” Click below and choose Allow Full Access."
        : result.status === "error"
          ? result.error
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

  if (result.events.length === 0) {
    return <p className="quad-placeholder">Nothing on the calendar today.</p>;
  }

  return (
    <ul className="cal-list">
      {result.events.map((event, index) => (
        <li className="cal-event" key={`${event.start}-${event.title}-${index}`}>
          <span className="cal-time">
            {event.allDay ? "All day" : formatTime(event.start)}
          </span>
          <span className="cal-event-main">
            <span className="cal-title">{event.title}</span>
            {event.calendar ? (
              <span className="cal-cal">{event.calendar}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
