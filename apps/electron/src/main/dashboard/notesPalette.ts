import { NOTE_COLORS, type Note, type NoteColor } from "./notesTypes";

export function nextColor(existing: Pick<Note, "color">[]): NoteColor {
  const counts = new Map<NoteColor, number>(
    NOTE_COLORS.map((color) => [color, 0]),
  );

  for (const note of existing) {
    if (counts.has(note.color)) {
      counts.set(note.color, (counts.get(note.color) ?? 0) + 1);
    }
  }

  let best: NoteColor = "yellow";
  let bestCount = Infinity;

  for (const color of NOTE_COLORS) {
    const count = counts.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }

  return best;
}
