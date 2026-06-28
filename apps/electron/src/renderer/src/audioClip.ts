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

export function windowSampleCount(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

export function accumulateWindow(
  chunks: Float32Array[],
  needed: number,
): { done: boolean; samples: number } {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  return { done: samples >= needed, samples };
}

const CAPTURE_RATE = 16000;

// Capture a fixed ~`seconds` window of 16 kHz mono int16 from the mic, then tear
// the graph down. Mirrors App.tsx's capture setup but accumulates a window
// instead of streaming. The accumulation math is windowSampleCount/accumulateWindow.
export async function recordClip(opts?: { seconds?: number; deviceId?: string }): Promise<Int16Array> {
  const seconds = opts?.seconds ?? 2;
  const needed = windowSampleCount(seconds, CAPTURE_RATE);
  const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: false };
  if (opts?.deviceId) audio.deviceId = { exact: opts.deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  const ctx = new Ctor({ sampleRate: CAPTURE_RATE });
  try {
    await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    const muted = ctx.createGain();
    muted.gain.value = 0;
    const chunks: Float32Array[] = [];
    const done = new Promise<void>((resolve) => {
      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        if (accumulateWindow(chunks, needed).done) resolve();
      };
    });
    source.connect(processor);
    processor.connect(muted);
    muted.connect(ctx.destination);
    await done;
    const flat: number[] = [];
    for (const c of chunks) for (const s of c) { flat.push(s); if (flat.length >= needed) break; }
    return convertFloatSamplesToLinear16(flat.slice(0, needed));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  }
}
