import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Voiceprint {
  id: string;
  vec: number[];
}

// Persists a titanet voiceprint per speaker at
// <userData>/speaker-profiles/<id>/voiceprint.json, computed by spawning the
// speaker_embed.py one-shot over the speaker's clips.
export class VoiceprintStore {
  constructor(
    private readonly userDataDirectory: string,
    private readonly pythonPath: string,
    private readonly scriptPath: string,
  ) {}

  private file(speakerId: string): string {
    return join(this.userDataDirectory, "speaker-profiles", speakerId, "voiceprint.json");
  }

  async compute(speakerId: string, clipsDir: string): Promise<number[]> {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.pythonPath, [this.scriptPath, clipsDir]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)),
      );
    });
    const vec = JSON.parse(stdout.trim()) as number[];
    const path = this.file(speakerId);
    await mkdir(join(this.userDataDirectory, "speaker-profiles", speakerId), {
      recursive: true,
    });
    await writeFile(path, JSON.stringify({ dim: vec.length, vec }));
    return vec;
  }

  async load(speakerId: string): Promise<number[] | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(speakerId), "utf8"));
      return Array.isArray(parsed.vec) ? (parsed.vec as number[]) : null;
    } catch {
      return null;
    }
  }

  async has(speakerId: string): Promise<boolean> {
    return (await this.load(speakerId)) !== null;
  }

  async loadAll(speakerIds: string[]): Promise<Voiceprint[]> {
    const out: Voiceprint[] = [];
    for (const id of speakerIds) {
      const vec = await this.load(id);
      if (vec) out.push({ id, vec });
    }
    return out;
  }

  async delete(speakerId: string): Promise<void> {
    await rm(this.file(speakerId), { force: true });
  }
}
