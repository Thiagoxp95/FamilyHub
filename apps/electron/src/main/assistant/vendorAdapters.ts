import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";
import { v1 as speechV1 } from "@google-cloud/speech";
import type { DiarizedWord } from "./types";
import type { GeminiLiveAdapter } from "./service";

interface GeminiLiveTextAdapterOptions {
  apiKey: string;
  model?: string;
}

export class GeminiLiveTextAdapter implements GeminiLiveAdapter {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor({
    apiKey,
    model = "gemini-3.1-flash-live-preview",
  }: GeminiLiveTextAdapterOptions) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async sendVerifiedTurn(prompt: string): Promise<string> {
    const chunks: string[] = [];
    let resolveResponse: (value: string) => void;
    let rejectResponse: (reason?: unknown) => void;
    const response = new Promise<string>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    const session = await this.ai.live.connect({
      callbacks: {
        onclose: () => {
          resolveResponse(chunks.join("").trim());
        },
        onerror: (error) => {
          rejectResponse(error);
        },
        onmessage: (message: LiveServerMessage) => {
          const text = extractLiveText(message);

          if (text) {
            chunks.push(text);
          }

          if (message.serverContent?.turnComplete) {
            resolveResponse(chunks.join("").trim());
            session.close();
          }
        },
      },
      config: {
        responseModalities: [Modality.TEXT],
      },
      model: this.model,
    });

    session.sendClientContent({
      turnComplete: true,
      turns: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const text = await response;
    return text.length > 0 ? text : "Gemini Live returned no text.";
  }
}

interface GoogleSpeechDiarizationOptions {
  languageCode?: string;
  maxSpeakerCount?: number;
  minSpeakerCount?: number;
  model?: string;
}

// Speaker diarization is only available on the v1 synchronous `recognize`
// method. The v2 API rejects diarization on `recognize` (HTTP 400, "Recognize
// does not support Speaker Diarization for the requested model") — there it is
// limited to the async BatchRecognize flow, which is unsuitable for streaming
// chunks. Authentication is Application Default Credentials (the user's gcloud
// ADC, or GOOGLE_APPLICATION_CREDENTIALS); no project id is needed in-band.
export class GoogleSpeechDiarizationAdapter {
  private readonly client: speechV1.SpeechClient;
  private readonly languageCode: string;
  private readonly maxSpeakerCount: number;
  private readonly minSpeakerCount: number;
  private readonly model: string;

  constructor({
    languageCode = "en-US",
    maxSpeakerCount = 6,
    minSpeakerCount = 1,
    model = "latest_long",
  }: GoogleSpeechDiarizationOptions = {}) {
    this.client = new speechV1.SpeechClient();
    this.languageCode = languageCode;
    this.maxSpeakerCount = maxSpeakerCount;
    this.minSpeakerCount = minSpeakerCount;
    this.model = model;
  }

  async recognizeLinear16(
    audio: Uint8Array,
    sampleRateHertz: number,
  ): Promise<DiarizedWord[]> {
    const [response] = await this.client.recognize({
      audio: {
        content: Buffer.from(audio).toString("base64"),
      },
      config: {
        audioChannelCount: 1,
        diarizationConfig: {
          enableSpeakerDiarization: true,
          maxSpeakerCount: this.maxSpeakerCount,
          minSpeakerCount: this.minSpeakerCount,
        },
        enableWordTimeOffsets: true,
        encoding: "LINEAR16",
        languageCode: this.languageCode,
        model: this.model,
        sampleRateHertz,
      },
    });

    // With diarization, the full set of speaker-tagged words is returned on the
    // final result; earlier results omit speaker tags.
    const words =
      response.results?.at(-1)?.alternatives?.[0]?.words?.map((word) => ({
        endOffsetMs: durationToMs(word.endTime),
        speakerLabel:
          word.speakerTag != null ? String(word.speakerTag) : "unknown",
        startOffsetMs: durationToMs(word.startTime),
        word: word.word ?? "",
      })) ?? [];

    return words.filter((word) => word.word.trim().length > 0);
  }
}

export function canUseRealVendors(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    (environment.GEMINI_API_KEY?.trim() ||
      environment.GOOGLE_API_KEY?.trim() ||
      environment.GOOGLE_API?.trim()) &&
      (environment.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
        environment.GOOGLE_CLOUD_PROJECT?.trim()),
  );
}

function extractLiveText(message: LiveServerMessage): string | null {
  const parts = message.serverContent?.modelTurn?.parts ?? [];
  const text = parts
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");

  return text.length > 0 ? text : null;
}

function durationToMs(duration: unknown): number {
  if (!duration || typeof duration !== "object") {
    return 0;
  }

  // Protobuf Duration int64 fields arrive as number or string depending on the
  // transport (gRPC vs REST), so coerce defensively.
  const seconds = toFiniteNumber(
    "seconds" in duration ? (duration as { seconds?: unknown }).seconds : 0,
  );
  const nanos = toFiniteNumber(
    "nanos" in duration ? (duration as { nanos?: unknown }).nanos : 0,
  );

  return seconds * 1_000 + Math.round(nanos / 1_000_000);
}

function toFiniteNumber(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 0;

  return Number.isFinite(parsed) ? parsed : 0;
}
