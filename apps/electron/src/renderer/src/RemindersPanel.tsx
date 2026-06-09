import { useEffect, useRef, useState } from "react";

// A reminder the assistant is completing: kept around (struck through + checked)
// even after it drops out of the live list, so the animation reads before it
// vanishes. `listName` is the list it belonged to so we re-attach the ghost to
// the right tab if the refresh removes it.
interface CompletingReminder {
  item: ReminderItem;
  listName: string;
}

// How long an optimistically-completed item lingers (struck through) before it
// fades away — independent of when the (possibly multi-second) AppleScript
// refresh confirms the mutation.
const COMPLETING_LINGER_MS = 10_000;

// Dated reminders are only shown when they're imminent (due within two weeks) or
// already overdue. Far-future dated items (months out) are hidden to keep the
// list focused on what's actionable now. Undated reminders always show.
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

function isDueVisible(item: ReminderItem, now: number): boolean {
  if (!item.due) {
    return true;
  }
  const due = new Date(item.due).getTime();
  if (Number.isNaN(due)) {
    return true; // unparseable due date → treat as undated and show
  }
  // due - now is negative when overdue and ≤ TWO_WEEKS_MS when within the window;
  // only strictly-far-future dates exceed it and get hidden.
  return due - now <= TWO_WEEKS_MS;
}

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
  const [completing, setCompleting] = useState<Map<string, CompletingReminder>>(
    new Map(),
  );

  // The completing callback fires from IPC and must read the freshest result
  // without re-subscribing on every render.
  const resultRef = useRef<RemindersResult | null>(null);
  resultRef.current = result;
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    window.familyHub.dashboard
      .getReminders()
      .then(setResult)
      .catch(() =>
        setResult({ status: "error", error: "Reminders unavailable." }),
      );

    return window.familyHub.dashboard.onReminders(setResult);
  }, []);

  // Optimistic completion: as soon as the assistant invokes complete_reminder,
  // strike the matching item through and tick its checkbox, then drop it after a
  // short linger regardless of how slowly the backend refresh confirms.
  useEffect(() => {
    const timers = timersRef.current;
    const unsubscribe = window.familyHub.dashboard.onReminderCompleting((id) => {
      const found = findReminderById(resultRef.current, id);
      if (!found) {
        return;
      }

      setCompleting((prev) => {
        if (prev.has(id)) {
          return prev;
        }
        const next = new Map(prev);
        next.set(id, found);
        return next;
      });

      const existing = timers.get(id);
      if (existing) {
        clearTimeout(existing);
      }
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setCompleting((prev) => {
            if (!prev.has(id)) {
              return prev;
            }
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
        }, COMPLETING_LINGER_MS),
      );
    });

    return () => {
      unsubscribe();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
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
  // Hide far-future dated reminders from the view (tab counts keep the true
  // total). The filter is display-only — the assistant still sees every item.
  const now = Date.now();
  const items = (list?.items ?? []).filter((item) => isDueVisible(item, now));

  // Keep struck-through ghosts visible after the backend refresh drops them, so
  // the completion animation isn't cut short.
  const presentIds = new Set(
    items.map((item) => item.id).filter((id): id is string => Boolean(id)),
  );
  const ghosts: ReminderItem[] = [];
  if (list) {
    for (const [id, entry] of completing) {
      if (entry.listName === list.name && !presentIds.has(id)) {
        ghosts.push(entry.item);
      }
    }
  }
  const rendered = [...items, ...ghosts];

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
        {rendered.map((item, index) => {
          const isCompleting = Boolean(item.id && completing.has(item.id));
          return (
            <li
              className={isCompleting ? "rem-item rem-item--completing" : "rem-item"}
              key={item.id ?? `${item.title}-${index}`}
            >
              <span className="rem-check" aria-hidden="true" />
              <span className="rem-title">{item.title}</span>
              {item.due ? (
                <span className="rem-due">{formatDue(item.due)}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Locate a reminder (and the list it lives in) by its Apple Reminders id.
function findReminderById(
  result: RemindersResult | null,
  id: string,
): CompletingReminder | null {
  if (result?.status !== "ok") {
    return null;
  }

  for (const list of result.lists) {
    const item = list.items.find((candidate) => candidate.id === id);
    if (item) {
      return { item, listName: list.name };
    }
  }

  return null;
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
