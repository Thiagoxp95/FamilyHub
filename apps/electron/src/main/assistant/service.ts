import { readAssistantConfigStatus } from "./config";
import type { AssistantEvent, AssistantSnapshot } from "./types";

const maxEvents = 20;
const displayWakePhrase = "Hey James";

export class AssistantService {
  private events: AssistantEvent[] = [];
  private isListening = false;
  private lastAssistantResponse: string | null = null;
  private lastTranscript: string | null = null;

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
    this.pushEvent("info", "Listening stopped.");
    return this.getSnapshot();
  }

  // Hooks used by the live-audio flow to surface activity in the snapshot panels.
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
      events: this.events,
      isListening: this.isListening,
      lastAssistantResponse: this.lastAssistantResponse,
      lastTranscript: this.lastTranscript,
      wakePhrase: displayWakePhrase,
    };
  }

  pushEvent(type: AssistantEvent["type"], message: string): void {
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
