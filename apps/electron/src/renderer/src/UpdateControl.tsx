import { useEffect, useState } from "react";

// Which action a click on the badge performs. Passive states have none.
export function badgeAction(state: UpdateState): "check" | "install" | null {
  switch (state) {
    case "idle":
    case "not-available":
    case "error":
      return "check";
    case "downloaded":
      return "install";
    case "checking":
    case "available":
    case "downloading":
      return null;
  }
}

// The version text, trailing glyph, label, and optional percent the badge shows.
// At rest the badge shows the running app version; once an update is known it
// shows that update's target version.
export function badgeContent(
  status: UpdaterStatus,
  appVersion: string,
): { version: string; glyph: string; label: string; percent?: number } {
  const tag = (raw: string): string => (raw ? `v${raw}` : "");
  // Once an update is in play we show *its* version. If the backend hasn't
  // supplied one yet, show no version rather than the running one next to a
  // download/restart glyph (which would read as "current version downloading").
  const target = tag(status.version ?? "");

  switch (status.state) {
    case "checking":
      return { version: tag(appVersion), glyph: "⟳", label: "Checking for updates…" };
    case "available":
      return { version: target, glyph: "↓", label: "Update available" };
    case "downloading":
      return {
        version: target,
        glyph: "↓",
        label: "Downloading update",
        percent: status.percent,
      };
    case "downloaded":
      return { version: target, glyph: "↻", label: "Update ready — restart" };
    case "error":
      return { version: tag(appVersion), glyph: "!", label: "Update failed — retry" };
    case "idle":
    case "not-available":
      return {
        version: tag(appVersion),
        glyph: "✓",
        label: "Up to date — check for updates",
      };
  }
}

export function UpdateControl(): React.JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ state: "idle" });
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    let mounted = true;

    window.familyHub
      .getVersion()
      .then((version) => {
        if (mounted) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        // Version is non-critical chrome; leave it blank if unavailable.
      });

    window.familyHub.updater
      .getStatus()
      .then((nextStatus) => {
        if (mounted) {
          setStatus(nextStatus);
        }
      })
      .catch(() => {
        // Backend not reachable (e.g. auto-updater disabled) — stay at idle so
        // the badge shows "up to date" rather than an error.
        if (mounted) {
          setStatus({ state: "idle" });
        }
      });

    const unsubscribe = window.familyHub.updater.onStatus((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <UpdateControlView
      status={status}
      appVersion={appVersion}
      onCheck={() => {
        void window.familyHub.updater
          .check()
          .then(setStatus)
          .catch(() => {
            setStatus({ state: "error", error: "Unable to check for updates." });
          });
      }}
      onInstall={() => {
        void window.familyHub.updater.install();
      }}
    />
  );
}

export function UpdateControlView({
  status,
  appVersion,
  onCheck,
  onInstall,
}: {
  appVersion: string;
  onCheck: () => void;
  onInstall: () => void;
  status: UpdaterStatus;
}): React.JSX.Element {
  const action = badgeAction(status.state);
  const { version, glyph, label, percent } = badgeContent(status, appVersion);
  const spinning = status.state === "checking";
  const ready = status.state === "downloaded";

  return (
    <button
      type="button"
      className={ready ? "version-badge version-badge--ready" : "version-badge"}
      aria-label={label}
      title={label}
      disabled={action === null}
      onClick={() => {
        if (action === "check") {
          onCheck();
        } else if (action === "install") {
          onInstall();
        }
      }}
    >
      {version ? <span className="version-badge__version">{version}</span> : null}
      <span
        aria-hidden="true"
        className={
          spinning
            ? "version-badge__glyph version-badge__glyph--spin"
            : "version-badge__glyph"
        }
      >
        {glyph}
      </span>
      {percent !== undefined ? (
        <span className="version-badge__percent">{percent}%</span>
      ) : null}
    </button>
  );
}
