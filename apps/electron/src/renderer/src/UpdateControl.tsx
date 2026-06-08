import { useEffect, useState } from "react";

export function UpdateControl(): React.JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ state: "idle" });

  useEffect(() => {
    let mounted = true;

    window.familyHub.updater
      .getStatus()
      .then((nextStatus) => {
        if (mounted) {
          setStatus(nextStatus);
        }
      })
      .catch(() => {
        // Backend not reachable (e.g. auto-updater disabled) — stay hidden and
        // seamless rather than showing a red error in the header.
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
      onCheck={() => {
        void window.familyHub.updater.check().then(setStatus).catch(() => {
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
  onCheck,
  onInstall,
}: {
  onCheck: () => void;
  onInstall: () => void;
  status: UpdaterStatus;
}): React.JSX.Element | null {
  switch (status.state) {
    case "available":
      return (
        <div className="update-control" role="status">
          <span>
            {status.version ? `${status.version} available` : "Update available"}
          </span>
          <span>Downloading...</span>
        </div>
      );
    case "checking":
      return (
        <div className="update-control" role="status">
          <span>Checking updates...</span>
        </div>
      );
    case "downloading":
      return (
        <div className="update-control" role="status">
          <span>Downloading {status.percent ?? 0}%</span>
        </div>
      );
    case "downloaded":
      return (
        <div className="update-control update-control--ready" role="status">
          <span>{status.version ? `${status.version} ready` : "Update ready"}</span>
          <button className="secondary-button" onClick={onInstall} type="button">
            Restart
          </button>
        </div>
      );
    case "error":
      return (
        <div className="update-control update-control--error" role="status">
          <span>{status.error ?? "Update failed."}</span>
          <button className="secondary-button" onClick={onCheck} type="button">
            Retry
          </button>
        </div>
      );
    case "idle":
    case "not-available":
      return (
        <div className="update-control" role="status">
          {status.state === "not-available" ? <span>Up to date</span> : null}
          <button className="secondary-button" onClick={onCheck} type="button">
            Check for updates
          </button>
        </div>
      );
  }
}
