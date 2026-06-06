import { readAssistantConfigStatus } from "./config";
import { evaluateWakeSessionTurn, isSessionEndCommand } from "./gating";
import type { FileSpeakerProfileStore } from "./profileStore";
import type {
  AssistantEvent,
  AssistantSnapshot,
  SessionSpeakerGateDecision,
  SpeakerProfileSummary,
} from "./types";

export interface GeminiLiveAdapter {
  sendVerifiedTurn(prompt: string): Promise<string>;
}

interface AssistantServiceOptions {
  gemini: GeminiLiveAdapter;
  profileStore: FileSpeakerProfileStore;
}

interface SubmitTranscriptTurnInput {
  speakerLabel: string;
  transcript: string;
}

export type TranscriptTurnResult =
  | {
      accepted: true;
      assistantResponse: string;
      speakerLabel: string;
      speakerName: string;
    }
  | {
      accepted: false;
      reason: Extract<SessionSpeakerGateDecision, { accepted: false }>["reason"];
      speakerLabel: string;
      speakerName?: string;
    };

const maxEvents = 20;
const sessionDurationMs = 60_000;
const wakePhrases = ["james"];
const displayWakePhrase = "James";

export class AssistantService {
  private readonly gemini: GeminiLiveAdapter;
  private readonly profileStore: FileSpeakerProfileStore;
  private currentSpeakerName: string | null = null;
  private events: AssistantEvent[] = [];
  private isListening = false;
  private lastAssistantResponse: string | null = null;
  private lastTranscript: string | null = null;
  private lockedSpeakerId: string | null = null;
  private lockedSpeakerLabel: string | null = null;
  private sessionExpiresAtMs: number | null = null;

  constructor({ gemini, profileStore }: AssistantServiceOptions) {
    this.gemini = gemini;
    this.profileStore = profileStore;
  }

  async listSpeakers(): Promise<SpeakerProfileSummary[]> {
    return this.profileStore.list();
  }

  async enrollSpeaker(name: string): Promise<SpeakerProfileSummary> {
    const speaker = await this.profileStore.create(name);
    this.pushEvent("info", `Added ${speaker.name}.`);
    return speaker;
  }

  async setSpeakerAllowed(
    speakerId: string,
    allowed: boolean,
  ): Promise<SpeakerProfileSummary | null> {
    const speaker = await this.profileStore.setAllowed(speakerId, allowed);

    if (speaker) {
      this.pushEvent(
        "info",
        `${speaker.name} is now ${speaker.allowed ? "allowed" : "disabled"}.`,
      );

      if (!speaker.allowed && speaker.id === this.lockedSpeakerId) {
        this.clearSessionLock();
      }
    }

    return speaker;
  }

  async deleteSpeaker(speakerId: string): Promise<boolean> {
    const deleted = await this.profileStore.delete(speakerId);

    if (deleted) {
      if (speakerId === this.lockedSpeakerId) {
        this.clearSessionLock();
      }

      this.pushEvent("info", "Deleted speaker.");
    }

    return deleted;
  }

  async startListening(): Promise<AssistantSnapshot> {
    if (this.isListening) {
      return this.getSnapshot();
    }

    this.isListening = true;
    this.pushEvent("info", `Listening for "${displayWakePhrase}".`);
    return this.getSnapshot();
  }

  async stopListening(): Promise<AssistantSnapshot> {
    this.isListening = false;
    this.clearSessionLock();
    this.pushEvent("info", "Listening stopped.");
    return this.getSnapshot();
  }

  async lockSessionSpeaker(
    speakerId: string,
    speakerLabel: string,
  ): Promise<AssistantSnapshot> {
    if (!this.isListening) {
      throw new Error("Assistant is not listening.");
    }

    const trimmedLabel = speakerLabel.trim();

    if (trimmedLabel.length === 0) {
      throw new Error("Speaker label is required.");
    }

    const speaker = (await this.profileStore.list()).find(
      (candidate) => candidate.id === speakerId,
    );

    if (!speaker) {
      throw new Error("Speaker not found.");
    }

    if (!speaker.allowed) {
      throw new Error("Speaker is disabled.");
    }

    this.lockedSpeakerId = speaker.id;
    this.lockedSpeakerLabel = trimmedLabel;
    this.currentSpeakerName = speaker.name;
    this.sessionExpiresAtMs = Date.now() + sessionDurationMs;
    this.pushEvent(
      "info",
      `Locked ${speaker.name} to Google speaker label ${trimmedLabel}.`,
    );
    return this.getSnapshot();
  }

  async submitTranscriptTurn({
    speakerLabel,
    transcript,
  }: SubmitTranscriptTurnInput): Promise<TranscriptTurnResult> {
    if (!this.isListening) {
      throw new Error("Assistant is not listening.");
    }

    const trimmedTranscript = transcript.trim();
    const trimmedLabel = speakerLabel.trim();

    if (trimmedTranscript.length === 0) {
      throw new Error("Transcript is required.");
    }

    if (trimmedLabel.length === 0) {
      throw new Error("Speaker label is required.");
    }

    this.clearExpiredSession();

    const decision = evaluateWakeSessionTurn({
      lockedSpeakerLabel: this.lockedSpeakerLabel,
      transcript: trimmedTranscript,
      turnSpeakerLabel: trimmedLabel,
      wakePhrases,
    });

    this.lastTranscript = trimmedTranscript;

    if (decision.sessionStarted) {
      this.startSessionForSpeakerLabel(trimmedLabel);
    }

    if (!decision.accepted) {
      const message =
        decision.reason === "wake_command_missing"
          ? `Wake phrase heard from speaker ${trimmedLabel}. Session opened.`
          : `Ignored speaker ${trimmedLabel}: "${trimmedTranscript}" (${formatReason(
              decision.reason,
            )}).`;

      this.pushEvent(
        decision.reason === "wake_command_missing" ? "info" : "ignored",
        message,
      );
      return {
        accepted: false,
        reason: decision.reason,
        speakerLabel: trimmedLabel,
        ...(this.currentSpeakerName
          ? { speakerName: this.currentSpeakerName }
          : {}),
      };
    }

    if (decision.prompt.length === 0) {
      this.pushEvent("info", "Session is active. Waiting for a command.");
      return {
        accepted: false,
        reason: "wake_command_missing",
        speakerLabel: trimmedLabel,
        ...(this.currentSpeakerName
          ? { speakerName: this.currentSpeakerName }
          : {}),
      };
    }

    if (isSessionEndCommand(decision.prompt)) {
      this.clearSessionLock();
      this.pushEvent("info", "Session ended.");
      return {
        accepted: false,
        reason: "session_ended",
        speakerLabel: trimmedLabel,
      };
    }

    this.extendSession();

    const speakerName = this.currentSpeakerName ?? "Session speaker";
    this.pushEvent("accepted", `${speakerName}: ${decision.prompt}`);

    const assistantResponse = await this.gemini.sendVerifiedTurn(decision.prompt);
    this.lastAssistantResponse = assistantResponse;
    this.pushEvent("assistant", assistantResponse);

    return {
      accepted: true,
      assistantResponse,
      speakerLabel: trimmedLabel,
      speakerName,
    };
  }

  // Hooks used by the live-audio flow to surface activity in the snapshot
  // panels without going through the text-turn gating machinery.
  noteHeard(transcript: string): void {
    const trimmed = transcript.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.lastTranscript = trimmed;
    this.pushEvent("accepted", `Heard: ${trimmed}`);
  }

  noteAssistantReply(text: string): void {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.lastAssistantResponse = trimmed;
    this.pushEvent("assistant", trimmed);
  }

  noteInfo(message: string): void {
    this.pushEvent("info", message);
  }

  async getSnapshot(): Promise<AssistantSnapshot> {
    return {
      config: readAssistantConfigStatus(),
      currentSpeakerName: this.currentSpeakerName,
      events: this.events,
      isListening: this.isListening,
      lastAssistantResponse: this.lastAssistantResponse,
      lastTranscript: this.lastTranscript,
      lockedSpeakerLabel: this.lockedSpeakerLabel,
      sessionExpiresAt: this.sessionExpiresAtMs
        ? new Date(this.sessionExpiresAtMs).toISOString()
        : null,
      wakePhrase: displayWakePhrase,
      speakers: await this.profileStore.list(),
    };
  }

  private clearSessionLock(): void {
    this.currentSpeakerName = null;
    this.lockedSpeakerId = null;
    this.lockedSpeakerLabel = null;
    this.sessionExpiresAtMs = null;
  }

  private clearExpiredSession(): void {
    if (this.sessionExpiresAtMs && Date.now() > this.sessionExpiresAtMs) {
      this.clearSessionLock();
      this.pushEvent("info", "Session expired.");
    }
  }

  private extendSession(): void {
    if (this.lockedSpeakerLabel) {
      this.sessionExpiresAtMs = Date.now() + sessionDurationMs;
    }
  }

  private startSessionForSpeakerLabel(speakerLabel: string): void {
    this.currentSpeakerName = "Session speaker";
    this.lockedSpeakerId = null;
    this.lockedSpeakerLabel = speakerLabel;
    this.sessionExpiresAtMs = Date.now() + sessionDurationMs;
    this.pushEvent(
      "info",
      `Wake phrase heard. Responding only to Google speaker ${speakerLabel}.`,
    );
  }

  private pushEvent(type: AssistantEvent["type"], message: string): void {
    this.events = [
      {
        at: new Date().toISOString(),
        message,
        type,
      },
      ...this.events,
    ].slice(0, maxEvents);
  }
}

export class PlaceholderGeminiLive implements GeminiLiveAdapter {
  async sendVerifiedTurn(prompt: string): Promise<string> {
    return `Gemini Live adapter is not configured yet. Verified text: ${prompt}`;
  }
}

function formatReason(reason: SessionSpeakerGateDecision["reason"]): string {
  return reason.replaceAll("_", " ");
}
