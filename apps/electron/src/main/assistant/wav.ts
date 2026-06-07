// Minimal canonical PCM WAV (mono, 16-bit) encoder for enrollment clips.
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate = rate * blockAlign
  buffer.writeUInt16LE(2, 32); // block align = channels * bytesPerSample
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (const [i, sample] of samples.entries()) {
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}
