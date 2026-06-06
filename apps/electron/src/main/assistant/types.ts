export interface SpeakerProfileSummary {
  allowed: boolean;
  createdAt: string;
  id: string;
  name: string;
}

export type SessionSpeakerGateDecision =
  | {
      accepted: true;
      reason: "accepted";
      prompt: string;
      sessionStarted: boolean;
    }
  | {
      accepted: false;
      reason:
        | "session_ended"
        | "speaker_label_mismatch"
        | "wake_command_missing"
        | "wake_phrase_missing";
      sessionStarted: boolean;
    };

export interface DiarizedWord {
  endOffsetMs: number;
  speakerLabel: string;
  startOffsetMs: number;
  word: string;
}

export interface DiarizedTurn {
  endOffsetMs: number;
  speakerLabel: string;
  startOffsetMs: number;
  transcript: string;
  words: DiarizedWord[];
}

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
  currentSpeakerName: string | null;
  events: AssistantEvent[];
  isListening: boolean;
  lastAssistantResponse: string | null;
  lastTranscript: string | null;
  lockedSpeakerLabel: string | null;
  sessionExpiresAt: string | null;
  wakePhrase: string;
  speakers: SpeakerProfileSummary[];
}
