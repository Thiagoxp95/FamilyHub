export type NoteColor = "yellow" | "pink" | "mint" | "blue" | "orange";

export const NOTE_COLORS: NoteColor[] = [
  "yellow",
  "pink",
  "mint",
  "blue",
  "orange",
];

export function isNoteColor(value: unknown): value is NoteColor {
  return (
    typeof value === "string" &&
    (NOTE_COLORS as readonly string[]).includes(value)
  );
}

export interface Note {
  id: string;
  text: string;
  emoji?: string;
  color: NoteColor;
  x: number;
  y: number;
  rotation: number;
  createdAt: number;
  updatedAt: number;
}

export interface NoteInput {
  text: string;
  emoji?: string;
  color?: NoteColor;
}

export interface NotePatch {
  text?: string;
  emoji?: string;
  color?: NoteColor;
  x?: number;
  y?: number;
  rotation?: number;
}
