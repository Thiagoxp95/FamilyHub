import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileSpeakerProfileStore } from "./profileStore";

async function createStore(): Promise<FileSpeakerProfileStore> {
  const directory = await mkdtemp(join(tmpdir(), "family-hub-profiles-"));
  return new FileSpeakerProfileStore(directory);
}

describe("FileSpeakerProfileStore", () => {
  it("loads an empty list when no metadata exists", async () => {
    const store = await createStore();

    await expect(store.list()).resolves.toEqual([]);
  });

  it("creates a speaker without requiring voiceprint bytes", async () => {
    const store = await createStore();
    const speaker = await store.create("Max");

    expect(speaker).toMatchObject({
      allowed: true,
      name: "Max",
    });
    expect(speaker.id).toMatch(/^speaker-/);
    await expect(store.list()).resolves.toEqual([speaker]);
  });

  it("toggles allowed state", async () => {
    const store = await createStore();
    const speaker = await store.create("Max");

    const updated = await store.setAllowed(speaker.id, false);

    expect(updated?.allowed).toBe(false);
    await expect(store.list()).resolves.toEqual([{ ...speaker, allowed: false }]);
  });

  it("deletes speaker metadata and profile bytes", async () => {
    const store = await createStore();
    const speaker = await store.create("Max");

    await expect(store.delete(speaker.id)).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(store.metadataPath, "utf8")).resolves.toContain(
      '"speakers": []',
    );
  });

  it("reloads persisted metadata from disk", async () => {
    const store = await createStore();
    const speaker = await store.create("Max");
    const reloadedStore = new FileSpeakerProfileStore(store.directory);

    await expect(reloadedStore.list()).resolves.toEqual([speaker]);
  });
});
