import { useEffect, useRef, useState } from "react";
import { NoteCard } from "./NoteCard";
import { clamp01, toNormalized, toPx } from "./notesGeometry";

const NOTE_COLORS: NoteColor[] = ["yellow", "pink", "mint", "blue", "orange"];

interface NotesCanvasProps {
  notes: Note[];
  onCreate: (input: NoteInput) => Promise<Note>;
  onDelete: (id: string) => Promise<void> | void;
  onUpdate: (id: string, patch: NotePatch) => Promise<void> | void;
}

interface Size {
  h: number;
  w: number;
}

interface DragState {
  baseX: number;
  baseY: number;
  pointerId: number;
  startX: number;
  startY: number;
}

function DraggableNote({
  children,
  note,
  onMoved,
  size,
}: {
  children: React.ReactNode;
  note: Note;
  onMoved: (x: number, y: number) => void;
  size: Size;
}): React.JSX.Element {
  const [position, setPosition] = useState(() => ({
    x: toPx(note.x, size.w),
    y: toPx(note.y, size.h),
  }));
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef(position);

  useEffect(() => {
    if (dragRef.current) {
      return;
    }

    const next = { x: toPx(note.x, size.w), y: toPx(note.y, size.h) };
    positionRef.current = next;
    setPosition(next);
  }, [note.x, note.y, size.h, size.w]);

  function moveTo(next: { x: number; y: number }): void {
    positionRef.current = next;
    setPosition(next);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.target instanceof HTMLElement) {
      const interactive = event.target.closest("button, textarea");
      if (interactive) {
        return;
      }
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      baseX: positionRef.current.x,
      baseY: positionRef.current.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    moveTo({
      x: clampPx(drag.baseX + event.clientX - drag.startX, size.w),
      y: clampPx(drag.baseY + event.clientY - drag.startY, size.h),
    });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onMoved(
      toNormalized(positionRef.current.x, size.w),
      toNormalized(positionRef.current.y, size.h),
    );
  }

  return (
    <div
      className="note-anchor"
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0) rotate(${note.rotation}deg)`,
      }}
    >
      {children}
    </div>
  );
}

export function NotesCanvas({
  notes,
  onCreate,
  onDelete,
  onUpdate,
}: NotesCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [colorMenuId, setColorMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [size, setSize] = useState<Size>({ h: 0, w: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const measure = (): void =>
      setSize({ h: canvas.clientHeight, w: canvas.clientWidth });
    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  async function addNoteAt(x?: number, y?: number): Promise<void> {
    const note = await onCreate({ text: "New note" });
    setEditingId(note.id);

    if (x !== undefined && y !== undefined) {
      await onUpdate(note.id, { x, y });
    }
  }

  return (
    <div className="notes-canvas-wrap">
      <div className="notes-canvas-toolbar">
        <button
          className="notes-add"
          onClick={() => void addNoteAt()}
          type="button"
        >
          + Add note
        </button>
      </div>
      <div
        className="notes-canvas"
        onDoubleClick={(event) => {
          if (event.target !== canvasRef.current || size.w === 0 || size.h === 0) {
            return;
          }

          const rect = canvasRef.current.getBoundingClientRect();
          void addNoteAt(
            clamp01((event.clientX - rect.left) / rect.width),
            clamp01((event.clientY - rect.top) / rect.height),
          );
        }}
        ref={canvasRef}
      >
        {notes.length === 0 ? (
          <div className="notes-empty">No notes yet.</div>
        ) : null}
        {size.w > 0
          ? notes.map((note) => (
              <DraggableNote
                key={note.id}
                note={note}
                onMoved={(x, y) => void onUpdate(note.id, { x, y })}
                size={size}
              >
                <NoteCard
                  editing={editingId === note.id}
                  note={note}
                  onCancel={() => setEditingId(null)}
                  onCommit={(text) => {
                    setEditingId(null);
                    void onUpdate(note.id, { text });
                  }}
                  onDelete={() => void onDelete(note.id)}
                  onStartEdit={() => setEditingId(note.id)}
                />
                <div className="note-swatches">
                  <button
                    aria-label="Change note color"
                    className="note-swatch-toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      setColorMenuId(colorMenuId === note.id ? null : note.id);
                    }}
                    title="Change color"
                    type="button"
                  >
                    🎨
                  </button>
                  {colorMenuId === note.id ? (
                    <div className="note-swatch-row">
                      {NOTE_COLORS.map((color) => (
                        <button
                          aria-label={`${color} note`}
                          className={`note-swatch note-${color}`}
                          key={color}
                          onClick={(event) => {
                            event.stopPropagation();
                            setColorMenuId(null);
                            void onUpdate(note.id, { color });
                          }}
                          type="button"
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </DraggableNote>
            ))
          : null}
      </div>
    </div>
  );
}

function clampPx(value: number, size: number): number {
  return Math.max(0, Math.min(size * 0.85, value));
}
