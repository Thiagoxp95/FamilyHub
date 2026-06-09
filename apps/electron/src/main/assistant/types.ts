export interface AssistantConfigStatus {
  gemini: boolean;
  googleSpeech: boolean;
  localListener: boolean;
}

export interface AssistantEvent {
  at: string;
  message: string;
  type: "accepted" | "assistant" | "ignored" | "info" | "error";
}

export interface AssistantSnapshot {
  config: AssistantConfigStatus;
  events: AssistantEvent[];
  isListening: boolean;
  lastAssistantResponse: string | null;
  lastTranscript: string | null;
  wakePhrase: string;
}
