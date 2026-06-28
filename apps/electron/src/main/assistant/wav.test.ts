// apps/electron/src/main/assistant/wav.test.ts
import { describe, expect, it } from "vitest";
import { pcm16ToWav } from "./wav";

describe("pcm16ToWav", () => {
  it("writes a 44-byte header + 2 bytes per sample", () => {
    const buf = pcm16ToWav(new Int16Array([0, 1, -1, 32767, -32768]), 16000);
    expect(buf.length).toBe(44 + 5 * 2);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.toString("ascii", 12, 16)).toBe("fmt ");
    expect(buf.toString("ascii", 36, 40)).toBe("data");
  });
  it("encodes fmt fields: PCM mono 16-bit @ given rate", () => {
    const buf = pcm16ToWav(new Int16Array([7]), 16000);
    expect(buf.readUInt16LE(20)).toBe(1); // audioFormat = PCM
    expect(buf.readUInt16LE(22)).toBe(1); // channels = mono
    expect(buf.readUInt32LE(24)).toBe(16000); // sampleRate
    expect(buf.readUInt32LE(28)).toBe(16000 * 2); // byteRate = rate*blockAlign
    expect(buf.readUInt16LE(32)).toBe(2); // blockAlign
    expect(buf.readUInt16LE(34)).toBe(16); // bitsPerSample
    expect(buf.readUInt32LE(40)).toBe(2); // data chunk size = 1 sample * 2
    expect(buf.readInt16LE(44)).toBe(7); // the sample
  });
  it("sets RIFF chunk size to 36 + data length", () => {
    const buf = pcm16ToWav(new Int16Array([1, 2, 3]), 16000);
    expect(buf.readUInt32LE(4)).toBe(36 + 3 * 2);
  });
});
