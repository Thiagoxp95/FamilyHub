// Pure: decode renderer base64 (int16 LE PCM) to Int16Array. Mirrors the
// renderer's base64ToInt16 but lives main-side for the saveClip handler.
export function decodePcm16(base64: string): Int16Array {
  if (!base64) return new Int16Array(0);
  const bytes = Buffer.from(base64, "base64");
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}
