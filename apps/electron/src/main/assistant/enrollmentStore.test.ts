// apps/electron/src/main/assistant/enrollmentStore.test.ts
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnrollmentStore } from "./enrollmentStore";

function freshStore() {
  return new EnrollmentStore(mkdtempSync(join(tmpdir(), "enroll-")));
}

describe("EnrollmentStore", () => {
  it("adds a member, lists it with zero samples", () => {
    const s = freshStore();
    const m = s.addMember("Mom");
    expect(m.name).toBe("Mom");
    expect(m.sampleCount).toBe(0);
    expect(s.listMembers().map((x) => x.name)).toEqual(["Mom"]);
  });
  it("rejects an empty/whitespace name", () => {
    const s = freshStore();
    expect(() => s.addMember("   ")).toThrow();
  });
  it("saves clips, increments count, writes wav files", () => {
    const s = freshStore();
    const m = s.addMember("Dad");
    expect(s.saveClip(m.id, new Int16Array([1, 2, 3])).sampleCount).toBe(1);
    expect(s.saveClip(m.id, new Int16Array([4, 5])).sampleCount).toBe(2);
    const files = readdirSync(s.clipsDir(m.id)).filter((f) => f.endsWith(".wav"));
    expect(files.length).toBe(2);
    expect(files).toContain("clip_0000.wav");
    expect(files).toContain("clip_0001.wav");
  });
  it("deleteLastClip decrements and removes the highest-index clip", () => {
    const s = freshStore();
    const m = s.addMember("Kid");
    s.saveClip(m.id, new Int16Array([1]));
    s.saveClip(m.id, new Int16Array([2]));
    expect(s.deleteLastClip(m.id).sampleCount).toBe(1);
    expect(readdirSync(s.clipsDir(m.id))).toContain("clip_0000.wav");
    expect(readdirSync(s.clipsDir(m.id))).not.toContain("clip_0001.wav");
  });
  it("next index is max existing + 1 (no clobber after a delete in the middle)", () => {
    const s = freshStore();
    const m = s.addMember("X");
    s.saveClip(m.id, new Int16Array([1])); // 0000
    s.saveClip(m.id, new Int16Array([2])); // 0001
    s.deleteLastClip(m.id); // removes 0001
    s.saveClip(m.id, new Int16Array([3])); // must be 0001 again (max 0000 + 1)
    expect(readdirSync(s.clipsDir(m.id)).sort()).toEqual(["clip_0000.wav", "clip_0001.wav"]);
  });
  it("deleteMember removes the dir", () => {
    const s = freshStore();
    const m = s.addMember("Gone");
    const dir = s.clipsDir(m.id);
    s.deleteMember(m.id);
    expect(existsSync(dir)).toBe(false);
    expect(s.listMembers()).toEqual([]);
  });
  it("rejects a path-traversal / non-slug member id and touches nothing", () => {
    const s = freshStore();
    const keep = s.addMember("Keep");
    for (const badId of ["../x", "a/b", "..", "Mom", "with space"]) {
      expect(() => s.deleteMember(badId)).toThrow(/invalid member id/);
      expect(() => s.saveClip(badId, new Int16Array([1]))).toThrow(/invalid member id/);
      expect(() => s.deleteLastClip(badId)).toThrow(/invalid member id/);
      expect(() => s.clipsDir(badId)).toThrow(/invalid member id/);
    }
    // The legit member and its clips are untouched.
    expect(s.listMembers().map((x) => x.name)).toEqual(["Keep"]);
    expect(existsSync(s.clipsDir(keep.id))).toBe(true);
  });
});
