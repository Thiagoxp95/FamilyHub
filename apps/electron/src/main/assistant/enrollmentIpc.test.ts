import { describe, expect, it } from "vitest";
import { decodePcm16 } from "./enrollmentIpc";

// Node-side equivalent of the renderer's int16ToBase64 — same byte layout,
// used only in tests so we avoid pulling browser-only audioClip.ts into the
// node tsconfig scope.
function int16ToBase64(samples: Int16Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

describe("decodePcm16", () => {
  it("round-trips an int16 array through base64", () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
    const decoded = decodePcm16(int16ToBase64(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
  it("returns empty for empty base64", () => {
    expect(decodePcm16("").length).toBe(0);
  });
});
