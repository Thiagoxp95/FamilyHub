import {
  GoogleGenAI,
  Modality,
  Type,
  type LiveServerMessage,
  type Session,
} from "@google/genai";

// A single bidirectional Gemini Live native-audio conversation: caller streams
// 16 kHz LINEAR16 microphone frames in; Gemini streams 24 kHz audio + input and
// output transcripts back. This wraps the websocket so the rest of the app deals
// in plain LiveEvents.

export type LiveEvent =
  | { kind: "inputTranscript"; text: string }
  | { kind: "outputTranscript"; text: string }
  | { kind: "audio"; data: string; mimeType: string }
  | { kind: "toolCall"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "interrupted" }
  | { kind: "turnComplete" };

export interface LiveSessionHandlers {
  onEvent: (event: LiveEvent) => void;
  onClosed: (reason: string) => void;
  onError: (message: string) => void;
}

export interface GeminiLiveSessionOptions {
  apiKey: string;
  model?: string;
  voiceName?: string;
  systemInstruction?: string;
}

const defaultModel = "gemini-2.5-flash-native-audio-preview-12-2025";
const defaultVoiceName = "Puck";
const defaultSystemInstruction =
  "You are James, a warm and concise family assistant. James is your assistant name, not a family member or calendar owner. Do not refer to yourself in the third person when summarizing family information. Answer in one or two short sentences, suitable for being spoken aloud. When the user signals they are finished — for example by saying goodbye, bye, see you later, that's all, never mind, thanks that's it, stop, or shut up — give a brief one-line farewell and then call the end_conversation function.";
const inputMimeType = "audio/pcm;rate=16000";

export const endConversationToolName = "end_conversation";

const conversationTools = [
  {
    functionDeclarations: [
      {
        name: endConversationToolName,
        description:
          'End the current voice conversation and return to waiting for the wake word. Call this as soon as the user signals they are done — e.g. "goodbye", "bye", "see you later", "that\'s all", "that\'s it", "never mind", "thanks that\'s all", "stop", or "shut up".',
        parameters: {
          type: Type.OBJECT,
          properties: {
            reason: {
              type: Type.STRING,
              description:
                "A short phrase describing why the conversation is ending (e.g. 'user said goodbye').",
            },
          },
        },
      },
    ],
  },
];

// Pure translation of a raw Live server message into ordered LiveEvents. Kept
// separate from the socket so it can be unit tested.
export function interpretLiveMessage(message: LiveServerMessage): LiveEvent[] {
  const events: LiveEvent[] = [];

  for (const call of message.toolCall?.functionCalls ?? []) {
    events.push({
      kind: "toolCall",
      id: call.id ?? "",
      name: call.name ?? "",
      args: (call.args as Record<string, unknown> | undefined) ?? {},
    });
  }

  const serverContent = message.serverContent;

  if (!serverContent) {
    return events;
  }

  if (serverContent.inputTranscription?.text) {
    events.push({
      kind: "inputTranscript",
      text: serverContent.inputTranscription.text,
    });
  }

  if (serverContent.outputTranscription?.text) {
    events.push({
      kind: "outputTranscript",
      text: serverContent.outputTranscription.text,
    });
  }

  for (const part of serverContent.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) {
      events.push({
        kind: "audio",
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType ?? "audio/pcm;rate=24000",
      });
    }
  }

  if (serverContent.interrupted) {
    events.push({ kind: "interrupted" });
  }

  if (serverContent.turnComplete) {
    events.push({ kind: "turnComplete" });
  }

  return events;
}

export class GeminiLiveSession {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly voiceName: string;
  private readonly systemInstruction: string;
  private session: Session | null = null;

  constructor({
    apiKey,
    model = defaultModel,
    voiceName = defaultVoiceName,
    systemInstruction = defaultSystemInstruction,
  }: GeminiLiveSessionOptions) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
    this.voiceName = voiceName;
    this.systemInstruction = systemInstruction;
  }

  async start(handlers: LiveSessionHandlers): Promise<void> {
    this.session = await this.ai.live.connect({
      callbacks: {
        onopen: () => {},
        onmessage: (message: LiveServerMessage) => {
          for (const event of interpretLiveMessage(message)) {
            handlers.onEvent(event);
          }
        },
        onerror: (error: unknown) => {
          handlers.onError(readErrorMessage(error));
        },
        onclose: (event: { reason?: string } | undefined) => {
          handlers.onClosed(event?.reason ?? "closed");
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } },
        },
        systemInstruction: { parts: [{ text: this.systemInstruction }] },
        tools: conversationTools,
      },
      model: this.model,
    });
  }

  sendAudioFrame(base64Pcm16k: string): void {
    this.session?.sendRealtimeInput({
      audio: { data: base64Pcm16k, mimeType: inputMimeType },
    });
  }

  sendToolResponse(
    id: string,
    name: string,
    response: Record<string, unknown>,
  ): void {
    this.session?.sendToolResponse({
      functionResponses: [id ? { id, name, response } : { name, response }],
    });
  }

  async close(): Promise<void> {
    try {
      this.session?.close();
    } catch {
      // Already closing/closed — nothing to do.
    }

    this.session = null;
  }

  get isOpen(): boolean {
    return this.session !== null;
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Gemini Live session error.";
}
