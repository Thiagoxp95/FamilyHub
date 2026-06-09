export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function toPx(normalized: number, size: number): number {
  return normalized * size;
}

export function toNormalized(px: number, size: number): number {
  if (size <= 0) {
    return 0;
  }

  return clamp01(px / size);
}
