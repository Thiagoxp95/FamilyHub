// apps/electron/src/main/ambient/suggestionService.ts
//
// Turns a TriggerEngine suggestion into an on-screen card: shows it (one at a
// time — a new show() expires whatever card is currently visible), auto-
// expires it after a timeout, and resolves it on tap ("accept"/"dismiss" via
// IPC) or on voice confirmation ("sure, James" while the card is up).
import type { LiveStateEvent, ToolRunner } from "../assistant/liveController";
import { calendarToolNames } from "../assistant/liveSession";
import type { MemoryStore } from "./memoryStore";
import type { TriggerSuggestion } from "./triggerEngine";

const DEFAULT_TIMEOUT_MS = 30_000;

// Matches "yes/yeah/sure/ok(ay)/do it" near "james" in either order, within a
// short word gap, so "sure, James, do that" and "James, yeah go ahead" both
// count as a voice accept without also matching unrelated chatter that merely
// mentions James.
const VOICE_ACCEPT_RE =
  /\b(?:yes|yeah|sure|ok(?:ay)?|do it)\b[\s\S]{0,20}\bjames\b|\bjames\b[\s\S]{0,20}\b(?:yes|yeah|sure|ok(?:ay)?|do it)\b/i;

interface VisibleCard {
  id: number;
  suggestion: TriggerSuggestion;
  timer: ReturnType<typeof setTimeout>;
}

export interface SuggestionServiceOptions {
  store: MemoryStore;
  sendLive: (event: LiveStateEvent) => void;
  runTool: ToolRunner;
  // → triggerEngine.noteDismissed(): an explicit dismissal cools the trigger
  // engine down so it doesn't immediately re-suggest the same thing.
  onDismissed: () => void;
  timeoutMs?: number;
  now?: () => number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class SuggestionService {
  private readonly store: MemoryStore;
  private readonly sendLive: (event: LiveStateEvent) => void;
  private readonly runTool: ToolRunner;
  private readonly onDismissed: () => void;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  private visible: VisibleCard | null = null;

  constructor(options: SuggestionServiceOptions) {
    this.store = options.store;
    this.sendLive = options.sendLive;
    this.runTool = options.runTool;
    this.onDismissed = options.onDismissed;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Shows a new card. Any card already visible is expired first (one at a time). */
  show(suggestion: TriggerSuggestion): void {
    if (this.visible) {
      this.resolveVisible("expired");
    }

    const id = this.store.addSuggestion(suggestion.kind, suggestion.suggestion, suggestion.payload);
    const timer = setTimeout(() => {
      this.resolveVisible("expired");
    }, this.timeoutMs);

    this.visible = { id, suggestion, timer };
    this.sendLive({
      type: "suggestion",
      id,
      kind: suggestion.kind,
      text: suggestion.suggestion,
    });
  }

  /** Voice-accept while a card is visible: "sure, James" / "James, yes" etc. */
  handleVoice(text: string): void {
    if (!this.visible) return;
    if (!VOICE_ACCEPT_RE.test(text)) return;
    void this.accept(this.visible.id);
  }

  async accept(id: number): Promise<void> {
    if (!this.visible || this.visible.id !== id) return;
    const card = this.visible;
    clearTimeout(card.timer);
    this.visible = null;

    try {
      await this.runMappedTool(card.suggestion);
    } catch {
      // A tool failure must not leave the service wedged — the card still
      // resolves as accepted so the UI doesn't get stuck.
    }

    this.store.setSuggestionStatus(card.id, "accepted");
    this.sendLive({ type: "suggestionResolved", id: card.id, status: "accepted" });
  }

  dismiss(id: number): void {
    if (!this.visible || this.visible.id !== id) return;
    this.resolveVisible("dismissed");
  }

  private resolveVisible(status: "expired" | "dismissed"): void {
    const card = this.visible;
    if (!card) return;
    clearTimeout(card.timer);
    this.visible = null;

    this.store.setSuggestionStatus(card.id, status);
    this.sendLive({ type: "suggestionResolved", id: card.id, status });

    if (status === "dismissed") {
      this.onDismissed();
    }
  }

  private async runMappedTool(suggestion: TriggerSuggestion): Promise<void> {
    const payload = suggestion.payload;

    switch (suggestion.kind) {
      case "reminder":
        await this.runTool(calendarToolNames.createReminder, {
          title: str(payload.title),
          due: str(payload.due),
        });
        return;
      case "calendar":
        await this.runTool(calendarToolNames.createEvent, {
          title: str(payload.title),
          start: str(payload.due),
        });
        return;
      case "shopping":
        await this.runTool(calendarToolNames.createReminder, {
          title: `Buy ${str(payload.item)}`,
          list: "Groceries",
        });
        return;
      case "question":
      case "other":
      default:
        // No tool: the renderer shows a voice hint ("Say 'Hey James' to
        // ask") instead of an accept affordance for these kinds.
        return;
    }
  }
}
