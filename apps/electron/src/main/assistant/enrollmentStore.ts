import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pcm16ToWav } from "./wav";

const SAMPLE_RATE = 16000;
const CLIP_RE = /^clip_\d{4}\.wav$/;

// Persists per-speaker enrollment clips under
// <userData>/speaker-profiles/<id>/clips/clip_NNNN.wav.
export class EnrollmentStore {
  private readonly root: string;

  constructor(userDataDirectory: string) {
    this.root = join(userDataDirectory, "speaker-profiles");
  }

  private clipsDir(speakerId: string): string {
    return join(this.root, speakerId, "clips");
  }

  private async clipFiles(speakerId: string): Promise<string[]> {
    try {
      const files = await readdir(this.clipsDir(speakerId));
      return files.filter((f) => CLIP_RE.test(f)).sort();
    } catch {
      return [];
    }
  }

  async countClips(speakerId: string): Promise<number> {
    return (await this.clipFiles(speakerId)).length;
  }

  async saveClip(speakerId: string, samples: Int16Array): Promise<number> {
    const dir = this.clipsDir(speakerId);
    await mkdir(dir, { recursive: true });
    const index = (await this.clipFiles(speakerId)).length;
    const name = `clip_${String(index).padStart(4, "0")}.wav`;
    await writeFile(join(dir, name), pcm16ToWav(samples, SAMPLE_RATE));
    return index + 1;
  }

  async deleteSpeakerClips(speakerId: string): Promise<void> {
    await rm(join(this.root, speakerId), { recursive: true, force: true });
  }
}
