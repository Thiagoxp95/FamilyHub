import { describe, expect, it } from "vitest";
import { base64ToInt16, int16ToBase64 } from "./audioClip";

describe("int16/base64 round-trip", () => {
  it("encodes and decodes int16 samples losslessly", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 12345]);
    const decoded = base64ToInt16(int16ToBase64(samples));
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  it("produces empty base64 for empty input", () => {
    expect(int16ToBase64(new Int16Array())).toBe("");
  });
});
