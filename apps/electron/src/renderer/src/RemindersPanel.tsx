import { useEffect, useState } from "react";

export function RemindersPanel({
  focusList,
}: {
  // When set (e.g. the assistant is talking about "To Buy"), select that list's
  // tab. Matched against the list names case-insensitively.
  focusList?: string | null;
} = {}): React.JSX.Element {
  const [result, setResult] = useState<RemindersResult | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    window.familyHub.dashboard
      .getReminders()
      .then(setResult)
      .catch(() =>
        setResult({ status: "error", error: "Reminders unavailable." }),
      );

    return window.familyHub.dashboard.onReminders(setResult);
  }, []);

  useEffect(() => {
    if (!focusList || result?.status !== "ok") {
      return;
    }

    const target = focusList.trim().toLowerCase();
    const exact = result.lists.findIndex(
      (reminderList) => reminderList.name.trim().toLowerCase() === target,
    );
    const index =
      exact >= 0
        ? exact
        : result.lists.findIndex((reminderList) => {
            const name = reminderList.name.trim().toLowerCase();
            return name.includes(target) || target.includes(name);
          });

    if (index >= 0) {
      setActiveTab(index);
    }
  }, [focusList, result]);

  function connect(): void {
    setConnecting(true);
    window.familyHub.dashboard
      .connectReminders()
      .then(setResult)
      .catch(() => setResult({ status: "error", error: "Reminders unavailable." }))
      .finally(() => setConnecting(false));
  }

  if (!result) {
    return <p className="quad-placeholder">Loading reminders…</p>;
  }

  if (result.status !== "ok") {
    return (
      <div className="connect-state">
        <p className="quad-placeholder">
          {result.status === "error"
            ? result.error
            : "FamilyHub needs access to your Reminders."}
        </p>
        <button
          className="connect-btn"
          disabled={connecting}
          onClick={connect}
          type="button"
        >
          {connecting ? "Waiting for permission…" : "Connect Reminders"}
        </button>
      </div>
    );
  }

  if (result.lists.length === 0) {
    return <p className="quad-placeholder">No reminders right now.</p>;
  }

  const safeTab = Math.min(activeTab, result.lists.length - 1);
  const list = result.lists[safeTab];

  return (
    <div className="rem">
      <div className="rem-tabs" role="tablist">
        {result.lists.map((reminderList, index) => (
          <button
            aria-selected={index === safeTab}
            className={index === safeTab ? "rem-tab active" : "rem-tab"}
            key={reminderList.name}
            onClick={() => setActiveTab(index)}
            role="tab"
            type="button"
          >
            {reminderList.name}
            <span className="rem-count">{reminderList.items.length}</span>
          </button>
        ))}
      </div>
      <ul className="rem-list">
        {(list?.items ?? []).map((item, index) => (
          <li className="rem-item" key={`${item.title}-${index}`}>
            <span className="rem-check" aria-hidden="true" />
            <span className="rem-title">{item.title}</span>
            {item.due ? <span className="rem-due">{formatDue(item.due)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDue(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date);
}
