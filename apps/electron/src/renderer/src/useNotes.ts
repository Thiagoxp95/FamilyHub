import { useCallback, useEffect, useState } from "react";

export function useNotes(): {
  createNote: (input: NoteInput) => Promise<Note>;
  deleteNote: (id: string) => Promise<void>;
  notes: Note[];
  updateNote: (id: string, patch: NotePatch) => Promise<void>;
} {
  const [notes, setNotes] = useState<Note[]>([]);

  useEffect(() => {
    window.familyHub.dashboard
      .getNotes()
      .then(setNotes)
      .catch(() => setNotes([]));

    return window.familyHub.dashboard.onNotes(setNotes);
  }, []);

  const createNote = useCallback(async (input: NoteInput) => {
    const note = await window.familyHub.dashboard.createNote(input);
    setNotes(await window.familyHub.dashboard.getNotes());
    return note;
  }, []);

  const updateNote = useCallback(async (id: string, patch: NotePatch) => {
    await window.familyHub.dashboard.updateNote(id, patch);
    setNotes(await window.familyHub.dashboard.getNotes());
  }, []);

  const deleteNote = useCallback(async (id: string) => {
    await window.familyHub.dashboard.deleteNote(id);
    setNotes(await window.familyHub.dashboard.getNotes());
  }, []);

  return { createNote, deleteNote, notes, updateNote };
}
