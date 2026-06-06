import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  // Dev: electron-vite runs with the working directory at the repo/app root.
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../../.env.local"),
  resolve(currentDir, "../../.env.local"),
  resolve(currentDir, "../../../../.env.local"),
  // Packaged: a stable, user-owned path outside the app bundle. The relative
  // candidates above all resolve inside the .app (or to "/") once packaged,
  // so this is the only path that works for a Finder-launched build.
  resolve(homedir(), ".familyhub", ".env"),
];

export function loadMainEnvironment(): void {
  for (const path of envCandidates) {
    if (existsSync(path)) {
      loadDotenv({ override: false, path });
    }
  }
}
