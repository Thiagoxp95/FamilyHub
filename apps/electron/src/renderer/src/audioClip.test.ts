import { describe, expect, it } from "vitest";
import { base64ToInt16, int16ToBase64, windowSampleCount, accumulateWindow } from "./audioClip";

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

describe("recordClip windowing", () => {
  it("windowSampleCount = round(seconds * rate)", () => {
    expect(windowSampleCount(2, 16000)).toBe(32000);
    expect(windowSampleCount(1.5, 16000)).toBe(24000);
  });
  it("accumulateWindow reports done only once the window is filled", () => {
    const a = accumulateWindow([new Float32Array(10000)], 32000);
    expect(a).toEqual({ done: false, samples: 10000 });
    const b = accumulateWindow([new Float32Array(20000), new Float32Array(20000)], 32000);
    expect(b.done).toBe(true);
    expect(b.samples).toBe(40000);
  });
});
