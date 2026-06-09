import { useEffect, useRef, useState } from "react";

interface NoteCardProps {
  editing: boolean;
  note: Note;
  onCancel: () => void;
  onCommit: (text: string) => void;
  onDelete: () => void;
  onStartEdit: () => void;
}

export function NoteCard({
  editing,
  note,
  onCancel,
  onCommit,
  onDelete,
  onStartEdit,
}: NoteCardProps): React.JSX.Element {
  const [draft, setDraft] = useState(note.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) {
      return;
    }

    setDraft(note.text);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
  }, [editing, note.text]);

  function commit(): void {
    const trimmed = draft.trim();
    if (trimmed) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  }

  return (
    <div className={`note-card note-${note.color}`} onDoubleClick={onStartEdit}>
      <button
        aria-label="Delete note"
        className="note-delete"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        title="Delete"
        type="button"
      >
        ×
      </button>
      {editing ? (
        <textarea
          className="note-text note-text-edit"
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          ref={textareaRef}
          value={draft}
        />
      ) : (
        <p className="note-text">
          {note.emoji ? <span className="note-emoji">{note.emoji}</span> : null}
          {note.text}
        </p>
      )}
    </div>
  );
}
