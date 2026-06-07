import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EnrollmentStore } from "./enrollmentStore";

describe("EnrollmentStore", () => {
  let dir: string;
  let store: EnrollmentStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fh-enroll-"));
    store = new EnrollmentStore(dir);
  });

  const pcm = () => new Int16Array([1, 2, 3, 4]);

  it("starts at zero clips for an unknown speaker", async () => {
    expect(await store.countClips("spk-1")).toBe(0);
  });

  it("saves clips with incrementing zero-padded names and counts them", async () => {
    expect(await store.saveClip("spk-1", pcm())).toBe(1);
    expect(await store.saveClip("spk-1", pcm())).toBe(2);
    const files = (
      await readdir(join(dir, "speaker-profiles", "spk-1", "clips"))
    ).sort();
    expect(files).toEqual(["clip_0000.wav", "clip_0001.wav"]);
    expect(await store.countClips("spk-1")).toBe(2);
  });

  it("removes all of a speaker's clips", async () => {
    await store.saveClip("spk-1", pcm());
    await store.deleteSpeakerClips("spk-1");
    expect(await store.countClips("spk-1")).toBe(0);
  });
});
