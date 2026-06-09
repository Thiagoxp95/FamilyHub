import { NotesCanvas } from "./NotesCanvas";
import { useNotes } from "./useNotes";

interface NotesPanelProps {
  variant?: "compact" | "expanded";
}

export function NotesPanel({
  variant = "compact",
}: NotesPanelProps): React.JSX.Element {
  const { createNote, deleteNote, notes, updateNote } = useNotes();

  if (variant === "expanded") {
    return (
      <NotesCanvas
        notes={notes}
        onCreate={createNote}
        onDelete={deleteNote}
        onUpdate={updateNote}
      />
    );
  }

  const preview = notes.slice(0, 4);

  return (
    <div className="notes-mini">
      {preview.length === 0 ? (
        <div className="notes-empty">No notes yet.</div>
      ) : (
        preview.map((note) => (
          <div className={`notes-mini-item note-${note.color}`} key={note.id}>
            <p className="note-text">
              {note.emoji ? <span className="note-emoji">{note.emoji}</span> : null}
              {note.text}
            </p>
          </div>
        ))
      )}
      <button
        className="notes-mini-add"
        onClick={() => void createNote({ text: "New note" })}
        type="button"
      >
        + Add note
      </button>
    </div>
  );
}
