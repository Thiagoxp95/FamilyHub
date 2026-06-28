// apps/electron/src/main/assistant/enrollmentStore.ts
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pcm16ToWav } from "./wav";

export interface EnrolledMember {
  id: string;
  name: string;
  sampleCount: number;
}

const SAMPLE_RATE = 16000;

export class EnrollmentStore {
  constructor(private readonly baseDir: string) {}

  private memberDir(id: string): string {
    return join(this.baseDir, id);
  }
  clipsDir(id: string): string {
    return join(this.memberDir(id), "clips");
  }
  private metaPath(id: string): string {
    return join(this.memberDir(id), "member.json");
  }

  private slug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "member";
  }

  addMember(name: string): EnrolledMember {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("member name required");
    // id = slug + short nonce derived from existing count, collision-safe within this store
    let id = this.slug(trimmed);
    let n = 1;
    while (existsSync(this.memberDir(id))) id = `${this.slug(trimmed)}-${n++}`;
    mkdirSync(this.clipsDir(id), { recursive: true });
    writeFileSync(this.metaPath(id), JSON.stringify({ id, name: trimmed }));
    return { id, name: trimmed, sampleCount: 0 };
  }

  private sampleCount(id: string): number {
    const dir = this.clipsDir(id);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".wav")).length;
  }

  listMembers(): EnrolledMember[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((d) => existsSync(this.metaPath(d)))
      .map((d) => {
        const meta = JSON.parse(readFileSync(this.metaPath(d), "utf8")) as { id: string; name: string };
        return { id: meta.id, name: meta.name, sampleCount: this.sampleCount(d) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  deleteMember(id: string): void {
    rmSync(this.memberDir(id), { recursive: true, force: true });
  }

  private nextIndex(id: string): number {
    const dir = this.clipsDir(id);
    if (!existsSync(dir)) return 0;
    const nums = readdirSync(dir)
      .map((f) => /^clip_(\d+)\.wav$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) + 1 : 0;
  }

  saveClip(id: string, pcm16: Int16Array): { sampleCount: number } {
    const dir = this.clipsDir(id);
    mkdirSync(dir, { recursive: true });
    const index = this.nextIndex(id);
    const name = `clip_${String(index).padStart(4, "0")}.wav`;
    writeFileSync(join(dir, name), pcm16ToWav(pcm16, SAMPLE_RATE));
    return { sampleCount: this.sampleCount(id) };
  }

  deleteLastClip(id: string): { sampleCount: number } {
    const dir = this.clipsDir(id);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => /^clip_\d+\.wav$/.test(f)).sort();
      const last = files[files.length - 1];
      if (last) rmSync(join(dir, last));
    }
    return { sampleCount: this.sampleCount(id) };
  }
}
