import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotesStore } from "./notesStore";

let dir = "";
let filePath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "familyhub-notes-"));
  filePath = join(dir, "hub-notes.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("notesStore", () => {
  it("returns an empty array before any note exists", async () => {
    const store = createNotesStore(filePath);

    expect(await store.getNotes()).toEqual([]);
  });

  it("creates a trimmed note with emoji, color, placement, and timestamps", async () => {
    const store = createNotesStore(filePath);
    const note = await store.createNote({ text: "  Comprar leite  " });

    expect(note.id).toBeTruthy();
    expect(note.text).toBe("Comprar leite");
    expect(note.emoji).toBe("🥛");
    expect(note.color).toBe("yellow");
    expect(note.x).toBeGreaterThanOrEqual(0);
    expect(note.y).toBeGreaterThanOrEqual(0);
    expect(note.createdAt).toBeGreaterThan(0);
    expect(await store.getNotes()).toHaveLength(1);
  });

  it("honors explicit emoji and color", async () => {
    const store = createNotesStore(filePath);
    const note = await store.createNote({
      text: "Family party",
      emoji: "🎉",
      color: "pink",
    });

    expect(note.emoji).toBe("🎉");
    expect(note.color).toBe("pink");
  });

  it("orders notes newest-first", async () => {
    const store = createNotesStore(filePath);
    const first = await store.createNote({ text: "first" });
    const second = await store.createNote({ text: "second" });

    expect((await store.getNotes()).map((note) => note.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("updates text, emoji, color, position, and updatedAt", async () => {
    const store = createNotesStore(filePath);
    const note = await store.createNote({ text: "old" });
    const updated = await store.updateNote(note.id, {
      text: "take the trash out",
      color: "mint",
      x: 0.4,
      y: 0.6,
    });

    expect(updated?.text).toBe("take the trash out");
    expect(updated?.emoji).toBe("🗑️");
    expect(updated?.color).toBe("mint");
    expect(updated?.x).toBe(0.4);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);
  });

  it("returns null when updating a missing id", async () => {
    const store = createNotesStore(filePath);

    expect(await store.updateNote("missing", { text: "x" })).toBeNull();
  });

  it("keeps an explicitly patched emoji over a derived one", async () => {
    const store = createNotesStore(filePath);
    const note = await store.createNote({ text: "New note" });
    const updated = await store.updateNote(note.id, {
      text: "buy milk",
      emoji: "⭐",
    });

    expect(updated?.emoji).toBe("⭐");
  });

  it("backfills a missing emoji from legacy notes", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        notes: [
          {
            id: "legacy-1",
            text: "Comprar leite",
            color: "yellow",
            x: 0.1,
            y: 0.1,
            rotation: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      "utf-8",
    );
    const store = createNotesStore(filePath);

    expect((await store.getNotes())[0]?.emoji).toBe("🥛");
  });

  it("deletes a note", async () => {
    const store = createNotesStore(filePath);
    const note = await store.createNote({ text: "bye" });

    await store.deleteNote(note.id);

    expect(await store.getNotes()).toEqual([]);
  });

  it("collapses a duplicate create made back-to-back", async () => {
    const store = createNotesStore(filePath);
    const first = await store.createNote({ text: "Feed the dog" });
    const second = await store.createNote({ text: "feed the dog " });

    expect(second.id).toBe(first.id);
    expect(await store.getNotes()).toHaveLength(1);
  });

  it("allows re-adding the same text after the duplicate window", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        notes: [
          {
            id: "old-1",
            text: "Feed the dog",
            emoji: "🐶",
            color: "yellow",
            x: 0.1,
            y: 0.1,
            rotation: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      "utf-8",
    );
    const store = createNotesStore(filePath);
    const again = await store.createNote({ text: "Feed the dog" });

    expect(again.id).not.toBe("old-1");
    expect(await store.getNotes()).toHaveLength(2);
  });

  it("serializes concurrent creates without losing any", async () => {
    const store = createNotesStore(filePath);

    await Promise.all([
      store.createNote({ text: "a" }),
      store.createNote({ text: "b" }),
      store.createNote({ text: "c" }),
    ]);

    expect(await store.getNotes()).toHaveLength(3);
  });
});
