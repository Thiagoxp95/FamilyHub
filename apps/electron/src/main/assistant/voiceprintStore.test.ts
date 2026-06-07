import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { VoiceprintStore } from "./voiceprintStore";

describe("VoiceprintStore", () => {
  let dir: string;
  let fakePy: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fh-vp-"));
    // a fake "python" that ignores args and prints a fixed JSON vector
    fakePy = join(dir, "fakepy.sh");
    await writeFile(fakePy, '#!/bin/sh\nprintf "[0.1, 0.2, 0.3]"\n');
    await chmod(fakePy, 0o755);
  });

  it("computes, stores, loads, and deletes a voiceprint", async () => {
    const store = new VoiceprintStore(dir, fakePy, "ignored.py");
    const clips = join(dir, "speaker-profiles", "spk-1", "clips");
    await mkdir(clips, { recursive: true });

    const vec = await store.compute("spk-1", clips);
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(await store.has("spk-1")).toBe(true);
    expect(await store.load("spk-1")).toEqual([0.1, 0.2, 0.3]);

    const all = await store.loadAll(["spk-1", "spk-2"]); // spk-2 has none
    expect(all).toEqual([{ id: "spk-1", vec: [0.1, 0.2, 0.3] }]);

    await store.delete("spk-1");
    expect(await store.has("spk-1")).toBe(false);
  });
});
