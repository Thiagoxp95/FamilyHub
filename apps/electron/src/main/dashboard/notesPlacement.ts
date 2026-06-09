export interface Placement {
  x: number;
  y: number;
  rotation: number;
}

const MAX = 0.85;

export function initialPlacement(
  index: number,
  rng: () => number = Math.random,
): Placement {
  const stagger = (index % 6) / 6;
  const x = clamp(0.08 + stagger * 0.72 + (rng() - 0.5) * 0.08, 0, MAX);
  const row = Math.floor(index / 6) % 3;
  const y = clamp(0.08 + row * 0.28 + (rng() - 0.5) * 0.08, 0, MAX);
  const rotation = Math.round((rng() - 0.5) * 12);

  return { x, y, rotation };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
