import { describe, expect, it } from "vitest";
import { pcm16ToWav } from "./wav";

describe("pcm16ToWav", () => {
  const samples = new Int16Array([0, 1, -1, 32767, -32768]);
  const wav = pcm16ToWav(samples, 16000);

  it("has a RIFF/WAVE/fmt/data header", () => {
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
  });

  it("declares mono 16-bit PCM at the given sample rate", () => {
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits/sample
  });

  it("sizes the buffer and data chunk to the samples", () => {
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2);
    expect(wav.readUInt32LE(4)).toBe(36 + samples.length * 2);
  });

  it("writes the samples as little-endian int16", () => {
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(46)).toBe(1);
    expect(wav.readInt16LE(48)).toBe(-1);
    expect(wav.readInt16LE(50)).toBe(32767);
    expect(wav.readInt16LE(52)).toBe(-32768);
  });
});
