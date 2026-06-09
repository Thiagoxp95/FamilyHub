import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Drive this Mac through the `cxdo` wrapper (Codex CLI computer-use, full
// bypass). The wrapper runs `codex exec` with the computer-use/browser plugins,
// so we just hand it a natural-language task that mentions @Computer.
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

function resolveCxdo(): string {
  const local = join(homedir(), ".local", "bin", "cxdo");
  return existsSync(local) ? local : "cxdo";
}

// Computer-use sessions can chain several UI steps; give them room but cap so a
// stuck run can't wedge the assistant forever.
const defaultTimeoutMs = 180_000;

export interface ComputerTaskResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export async function runComputerTask(
  task: string,
  timeoutMs: number = defaultTimeoutMs,
): Promise<ComputerTaskResult> {
  const trimmed = task.trim();
  if (!trimmed) {
    return { ok: false, error: "No task was provided." };
  }

  // The wrapper keys off an @Computer mention to load the right tools; prepend
  // one when the model didn't already phrase it that way.
  const prompt = /@computer/i.test(trimmed)
    ? trimmed
    : `Use @Computer to ${trimmed}`;

  const cxdo = resolveCxdo();
  const env = {
    ...process.env,
    PATH: `${extraPath.join(":")}:${process.env.PATH ?? ""}`,
  };

  return new Promise<ComputerTaskResult>((resolve) => {
    execFile(
      cxdo,
      [prompt],
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout ?? "").trim();
        if (err) {
          const reason = (stderr ?? "").trim() || err.message;
          resolve(out ? { ok: false, error: reason, output: out } : { ok: false, error: reason });
          return;
        }
        resolve({ ok: true, output: out });
      },
    );
  });
}
