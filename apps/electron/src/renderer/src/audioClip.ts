export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 2),
  );
}

export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function convertFloatSamplesToLinear16(samples: number[]): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (const [index, sample] of samples.entries()) {
    const clampedSample = Math.max(-1, Math.min(1, sample));
    pcm[index] = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff;
  }
  return pcm;
}
