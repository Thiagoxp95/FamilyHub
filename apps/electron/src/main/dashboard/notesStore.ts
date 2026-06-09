import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { moodEmoji } from "./notesEmoji";
import { nextColor } from "./notesPalette";
import { initialPlacement } from "./notesPlacement";
import type { Note, NoteInput, NotePatch } from "./notesTypes";

const DUPLICATE_WINDOW_MS = 5_000;

export interface NotesStore {
  createNote(input: NoteInput): Promise<Note>;
  deleteNote(id: string): Promise<{ deleted: true; id: string }>;
  getNotes(): Promise<Note[]>;
  updateNote(id: string, patch: NotePatch): Promise<Note | null>;
}

export function createUserDataNotesStore(userDataDirectory: string): NotesStore {
  return createNotesStore(join(userDataDirectory, "hub-notes.json"));
}

export function createNotesStore(filePath: string): NotesStore {
  let writeChain: Promise<unknown> = Promise.resolve();

  async function readAll(): Promise<Note[]> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as { notes?: unknown };

      if (!Array.isArray(parsed.notes)) {
        return [];
      }

      return (parsed.notes as Note[]).map((note) =>
        note.emoji ? note : { ...note, emoji: moodEmoji(note.text) },
      );
    } catch (error) {
      if (isErrno(error, "ENOENT") || error instanceof SyntaxError) {
        return [];
      }

      throw error;
    }
  }

  async function writeAllAtomic(notes: Note[]): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ notes }, null, 2), "utf-8");
    await fs.rename(tmp, filePath);
  }

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => undefined);
    return next;
  }

  return {
    async getNotes(): Promise<Note[]> {
      return runExclusive(async () => sorted(await readAll()));
    },

    async createNote(input: NoteInput): Promise<Note> {
      return runExclusive(async () => {
        const notes = await readAll();
        const now = Date.now();
        const text = input.text.trim();
        const key = text.toLowerCase();
        const recentDuplicate = notes.find(
          (note) =>
            note.text.trim().toLowerCase() === key &&
            now - note.createdAt < DUPLICATE_WINDOW_MS,
        );

        if (recentDuplicate) {
          return recentDuplicate;
        }

        const placement = initialPlacement(notes.length);
        const note: Note = {
          id: randomUUID(),
          text,
          emoji: input.emoji ?? moodEmoji(text),
          color: input.color ?? nextColor(notes),
          x: placement.x,
          y: placement.y,
          rotation: placement.rotation,
          createdAt: now,
          updatedAt: now,
        };

        await writeAllAtomic([note, ...notes]);
        return note;
      });
    },

    async updateNote(id: string, patch: NotePatch): Promise<Note | null> {
      return runExclusive(async () => {
        const notes = await readAll();
        const index = notes.findIndex((note) => note.id === id);

        if (index === -1) {
          return null;
        }

        const current = notes[index];
        if (!current) {
          return null;
        }

        const nextText =
          patch.text !== undefined ? patch.text.trim() : current.text;
        const nextEmoji =
          patch.emoji !== undefined
            ? patch.emoji
            : patch.text !== undefined
              ? moodEmoji(nextText)
              : (current.emoji ?? moodEmoji(nextText));
        const updated: Note = {
          ...current,
          ...(patch.text !== undefined ? { text: nextText } : {}),
          emoji: nextEmoji,
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.x !== undefined ? { x: patch.x } : {}),
          ...(patch.y !== undefined ? { y: patch.y } : {}),
          ...(patch.rotation !== undefined ? { rotation: patch.rotation } : {}),
          updatedAt: Date.now(),
        };

        notes[index] = updated;
        await writeAllAtomic(notes);
        return updated;
      });
    },

    async deleteNote(id: string): Promise<{ deleted: true; id: string }> {
      return runExclusive(async () => {
        const notes = await readAll();
        await writeAllAtomic(notes.filter((note) => note.id !== id));
        return { deleted: true, id };
      });
    },
  };
}

function sorted(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => b.createdAt - a.createdAt);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
