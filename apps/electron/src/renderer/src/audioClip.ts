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

// Play an int16 PCM clip once via a transient AudioContext (enrollment review).
export function playClip(samples: Int16Array, sampleRate = 16000): void {
  const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
  const audioContext = new AudioContextConstructor();
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = (samples[i] ?? 0) / 0x8000;
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = () => void audioContext.close();
  source.start();
}

// Capture a fixed window of 16 kHz mono int16 from the mic. Mirrors the wake
// capture setup but buffers a clip instead of streaming frames. Owns and frees
// its own AudioContext + stream.
export async function recordClip(
  durationMs = 2000,
  sampleRate = 16000,
): Promise<Int16Array> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone is not available.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
  const audioContext = new AudioContextConstructor({ sampleRate });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mutedOutput = audioContext.createGain();
  mutedOutput.gain.value = 0;

  const samples: number[] = [];
  const target = Math.floor((durationMs / 1000) * sampleRate);

  return new Promise<Int16Array>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      processor.disconnect();
      source.disconnect();
      mutedOutput.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void audioContext.close();
      resolve(convertFloatSamplesToLinear16(samples.slice(0, target)));
    };
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i += 1) samples.push(input[i] ?? 0);
      if (samples.length >= target) finish();
    };
    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(audioContext.destination);
    setTimeout(() => {
      if (samples.length === 0) {
        for (const track of stream.getTracks()) track.stop();
        void audioContext.close();
        reject(new Error("No audio captured."));
      } else {
        finish();
      }
    }, durationMs + 1500);
  });
}
