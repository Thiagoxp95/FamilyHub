import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Drive this Mac for the voice assistant. Two paths:
//
//   1. Fast path — a bare "open <app>" or "go to <url>" is handled by macOS's
//      own `open` command. It's instant, never fails the way a UI agent can,
//      and crucially it is NOT subject to Codex computer-use's browser URL
//      blocklist (which refuses many news/media sites even when the user
//      navigates there themselves). Launching a URL is just a LaunchServices
//      open, not the model visually driving the browser.
//
//   2. Full path — anything that needs real UI interaction (search, click,
//      type, play, write…) goes through the `cxdo` wrapper (Codex CLI
//      computer-use, full bypass), which screenshots and controls apps.
//
// codex exec needs the right binaries on PATH; an Electron GUI process inherits
// a stripped PATH, so we widen it to the usual user/Homebrew locations.
const extraPath = [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${extraPath.join(":")}:${process.env.PATH ?? ""}`,
  };
}

function resolveCxdo(): string {
  const local = join(homedir(), ".local", "bin", "cxdo");
  return existsSync(local) ? local : "cxdo";
}

// Computer-use sessions can chain several UI steps; give them room but cap so a
// stuck run can't wedge the assistant forever.
const defaultTimeoutMs = 180_000;
// The direct `open` path is effectively instant; don't let it hang.
const openTimeoutMs = 10_000;

export interface ComputerTaskResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export type ComputerTaskPlan =
  | { kind: "open-url"; url: string; app?: string }
  | { kind: "open-app"; app: string }
  | { kind: "computer-use" };

// Verbs that mean the task needs real UI interaction — never fast-path these,
// even if they also mention an app or URL.
const interactionPattern =
  /\b(search|searching|click|clicks|type|types|typing|plays?|playing|pause|writes?|writing|fill|log ?in|sign ?in|post|sends?|add|adds|buy|order|scroll|watch|download|compose|repl(?:y|ies)|likes?|shares?|book|enables?|disables?|toggles?|press|selects?|choose|chooses|create|creates|delete|deletes|rename|drag|screenshot|summari[sz]e|look up)\b/i;

// Named browsers → their macOS application name (for `open -a`).
const browsers: Array<[RegExp, string]> = [
  [/\bgoogle chrome\b/i, "Google Chrome"],
  [/\bchrome\b/i, "Google Chrome"],
  [/\bsafari\b/i, "Safari"],
  [/\barc\b/i, "Arc"],
  [/\bfirefox\b/i, "Firefox"],
  [/\bmicrosoft edge\b/i, "Microsoft Edge"],
  [/\bedge\b/i, "Microsoft Edge"],
  [/\bbrave\b/i, "Brave Browser"],
];

// A domain (optionally with scheme/path). Requires at least one dot and a 2+
// char TLD so plain app names like "Calculator" don't match.
const urlPattern =
  /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/i;

function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

// Decide how to carry out a natural-language computer task. Pure + deterministic
// so the routing is unit-tested; runComputerTask just executes the plan.
export function planComputerTask(task: string): ComputerTaskPlan {
  const t = task.trim();
  if (!t) {
    return { kind: "computer-use" };
  }

  // Anything that needs clicking/typing/playing must use the full agent.
  if (interactionPattern.test(t)) {
    return { kind: "computer-use" };
  }

  // Pure navigation: open a URL directly (dodges the computer-use blocklist).
  const urlMatch = t.match(urlPattern);
  if (urlMatch?.[1]) {
    const url = normalizeUrl(urlMatch[1]);
    const app = browsers.find(([re]) => re.test(t))?.[1];
    return app ? { kind: "open-url", url, app } : { kind: "open-url", url };
  }

  // Pure app launch: "open <app>", "launch <app>", "open the <app> app".
  const appMatch = t.match(
    /^(?:please\s+)?(?:open|launch|start|fire up|bring up)\s+(?:the\s+)?(.+?)(?:\s+app)?[.!]?$/i,
  );
  if (appMatch?.[1]) {
    const app = appMatch[1].trim();
    // A real single app name — reject multi-app / lingering action phrasing.
    if (app && !/\band\b|,/i.test(app) && app.split(/\s+/).length <= 4) {
      return { kind: "open-app", app };
    }
  }

  return { kind: "computer-use" };
}

export async function runComputerTask(
  task: string,
  timeoutMs: number = defaultTimeoutMs,
): Promise<ComputerTaskResult> {
  const trimmed = task.trim();
  if (!trimmed) {
    return { ok: false, error: "No task was provided." };
  }

  const plan = planComputerTask(trimmed);
  if (plan.kind === "open-url" || plan.kind === "open-app") {
    const quick = await runOpen(plan);
    if (quick.ok) {
      return quick;
    }
    // A misheard app name (or odd URL) — let the smarter agent have a go rather
    // than surfacing a raw `open` failure.
  }

  return runWithCxdo(trimmed, timeoutMs);
}

// macOS `open`: launch an app, or open a URL (optionally in a named browser).
function runOpen(
  plan: { kind: "open-url"; url: string; app?: string } | { kind: "open-app"; app: string },
): Promise<ComputerTaskResult> {
  const args =
    plan.kind === "open-url"
      ? plan.app
        ? ["-a", plan.app, plan.url]
        : [plan.url]
      : ["-a", plan.app];

  return new Promise<ComputerTaskResult>((resolve) => {
    execFile(
      "open",
      args,
      { env: buildEnv(), timeout: openTimeoutMs },
      (err, _stdout, stderr) => {
        if (err) {
          const reason = (stderr ?? "").trim() || err.message;
          resolve({ ok: false, error: reason });
          return;
        }
        const output =
          plan.kind === "open-url"
            ? `Opened ${plan.app ?? "the browser"} at ${plan.url}.`
            : `Opened ${plan.app}.`;
        resolve({ ok: true, output });
      },
    );
  });
}

function runWithCxdo(
  task: string,
  timeoutMs: number,
): Promise<ComputerTaskResult> {
  // The wrapper keys off an @Computer mention to load the right tools; prepend
  // one when the model didn't already phrase it that way.
  const prompt = /@computer/i.test(task) ? task : `Use @Computer to ${task}`;

  const cxdo = resolveCxdo();

  return new Promise<ComputerTaskResult>((resolve) => {
    execFile(
      cxdo,
      [prompt],
      { env: buildEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout ?? "").trim();
        if (err) {
          const reason = (stderr ?? "").trim() || err.message;
          resolve(
            out
              ? { ok: false, error: reason, output: out }
              : { ok: false, error: reason },
          );
          return;
        }
        resolve({ ok: true, output: out });
      },
    );
  });
}
