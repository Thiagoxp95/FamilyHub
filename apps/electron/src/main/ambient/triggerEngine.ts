// apps/electron/src/main/ambient/triggerEngine.ts
//
// "Can James help right now?" classifier: runs after every ambient
// utterance and asks the local LLM whether the rolling kitchen transcript
// contains something worth surfacing as a proactive suggestion (a
// reminder, calendar event, factual question, or shopping item).
import type { MemoryStore, StoredUtterance } from "./memoryStore";
import type { OllamaClient } from "./ollama";

const WINDOW_MAX_WORDS = 500;
const CONFIDENCE_THRESHOLD = 0.7;
const DISMISS_COOLDOWN_MS = 2 * 60 * 1000;
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const DEDUPE_COSINE_THRESHOLD = 0.85;

const TRIGGER_KINDS = new Set(["reminder", "calendar", "question", "shopping", "other"]);

export type TriggerKind = "reminder" | "calendar" | "question" | "shopping" | "other";

export interface TriggerSuggestion {
  kind: TriggerKind;
  confidence: number;
  suggestion: string; // human sentence for the card
  payload: Record<string, unknown>; // e.g. { title, due } for reminder kind
}

export interface TriggerEngineOptions {
  store: MemoryStore;
  ollama: OllamaClient;
  onSuggestion: (suggestion: TriggerSuggestion) => void;
  now?: () => number; // injectable clock for tests
}

// SYNC: scripts/trigger-bench.mjs keeps its own copy of TRIGGER_SCHEMA and
// the SYSTEM_PROMPT_PREFIX/SUFFIX below (it can't import this Electron-main
// module from plain Node) — if you edit either here, mirror the edit there
// and re-run `node scripts/trigger-bench.mjs`.
const TRIGGER_SCHEMA = {
  type: "object",
  properties: {
    trigger: { type: "boolean" },
    kind: { enum: ["reminder", "calendar", "question", "shopping", "other"] },
    confidence: { type: "number" },
    suggestion: { type: "string" },
    payload: { type: "object" },
  },
  required: ["trigger", "kind", "confidence", "suggestion", "payload"],
};

const SYSTEM_PROMPT_PREFIX =
  "You watch a rolling transcript of a family's kitchen conversation. Decide " +
  "whether the voice assistant (James) could usefully offer help RIGHT NOW, " +
  "focusing on the most recent topic and using the rest as context. Today is ";

const SYSTEM_PROMPT_SUFFIX = `. The family mixes English and Portuguese; treat both the same.

Set trigger true (confidence 0.8 or higher) when the transcript contains ANY of:
1. A FUTURE commitment, appointment, or deadline: a party, doctor/dentist visit, school pickup, meeting, haircut, or bill due date (kind "reminder" or "calendar"; payload {"title", "due" ISO local}). Capturing it as a reminder helps even when the speakers sound organized, and even when the last line is just someone acknowledging it.
2. A factual question asked aloud (distance, weather, unit conversion, general facts, travel time) that nobody answered CONFIDENTLY (kind "question"; payload {"question"}). "I think...", "not sure", "maybe", "depends" are guesses, not answers — still trigger.
3. A household item that is out, almost out, or running low, or an explicit ask to buy something or add it to a list (kind "shopping"; payload {"item"}). Using up the last of something counts — that means it needs restocking.

Set trigger false ONLY for:
- Chit-chat, opinions, feelings, or emotional support.
- TV/radio/media audio in the background, or kids playing pretend.
- Recipe or instruction steps being read aloud.
- Strictly PAST or already-handled things: events that already happened, bills already paid, questions already answered confidently in the transcript.

Examples:
"We're almost out of ketchup." -> {"trigger": true, "kind": "shopping", "confidence": 0.9, "suggestion": "Add ketchup to the shopping list?", "payload": {"item": "ketchup"}}
"Liam's soccer game is Friday at 5pm." -> {"trigger": true, "kind": "reminder", "confidence": 0.9, "suggestion": "Create a reminder: Liam's soccer game, Friday 5pm?", "payload": {"title": "Liam's soccer game", "due": "2026-07-17T17:00:00"}}
"How tall is the Eiffel Tower?" / "Maybe three hundred meters?" -> {"trigger": true, "kind": "question", "confidence": 0.85, "suggestion": "Want me to look up how tall the Eiffel Tower is?", "payload": {"question": "How tall is the Eiffel Tower?"}}
"I'm exhausted after that workout." / "You earned a rest." -> {"trigger": false, "kind": "other", "confidence": 0.9, "suggestion": "", "payload": {}}
"Did you book the car service?" / "Yes, I did it this morning." -> {"trigger": false, "kind": "other", "confidence": 0.9, "suggestion": "", "payload": {}}

If the transcript matches one of the three trigger categories, prefer trigger true. suggestion is one short sentence.`;

interface ParsedTriggerResult {
  trigger: boolean;
  kind: TriggerKind;
  confidence: number;
  suggestion: string;
  payload: Record<string, unknown>;
}

interface RecentSuggestionEntry {
  vector: Float32Array | null;
  text: string;
  at: number;
}

// The model's response is untrusted (network hop + JSON parse already
// happened in ollama.ts). Validate the shape fully before trusting any of
// it, matching factsDigest's parseFacts precedent — a malformed-but-non-null
// response must be treated the same as a failed call, not crash or fire a
// garbage suggestion.
function parseTriggerResult(raw: unknown): ParsedTriggerResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.trigger !== "boolean") return null;
  if (typeof r.kind !== "string" || !TRIGGER_KINDS.has(r.kind)) return null;
  if (typeof r.confidence !== "number" || Number.isNaN(r.confidence)) return null;
  if (typeof r.suggestion !== "string") return null;
  if (typeof r.payload !== "object" || r.payload === null || Array.isArray(r.payload)) {
    return null;
  }

  return {
    trigger: r.trigger,
    kind: r.kind as TriggerKind,
    confidence: r.confidence,
    suggestion: r.suggestion,
    payload: r.payload as Record<string, unknown>,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// LOCAL wall-clock datetime (same local-time semantics as factsDigest's
// localIsoDate). toISOString() would anchor in UTC, which misresolves
// relative dates/times ("tonight", "in an hour") for any non-UTC timezone.
function localIsoDateTime(now: number): string {
  const d = new Date(now);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function formatHHMM(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatWindow(utterances: StoredUtterance[]): string {
  return utterances.map((u) => `[${formatHHMM(u.ts)}] ${u.text}`).join("\n");
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Runs after every ambient utterance and asks the local LLM whether the
 * rolling kitchen transcript contains something James could usefully offer
 * to help with right now. Fire-and-forget: `handleUtterance` never throws
 * and never blocks the caller — a single background runner processes one
 * classification at a time, and rapid-fire calls collapse to "latest wins"
 * (only the most recent pending call actually reaches the LLM once the
 * in-flight one completes).
 */
export class TriggerEngine {
  private readonly store: MemoryStore;
  private readonly ollama: OllamaClient;
  private readonly onSuggestion: (suggestion: TriggerSuggestion) => void;
  private readonly now: () => number;

  // Queue depth 1: only the latest queued text survives a burst of calls
  // that land while a classification is already in flight.
  private pendingText: string | null = null;
  private running = false;
  private runPromise: Promise<void> | null = null;

  private dismissedUntil = 0;
  private recentSuggestions: RecentSuggestionEntry[] = [];

  constructor(options: TriggerEngineOptions) {
    this.store = options.store;
    this.ollama = options.ollama;
    this.onSuggestion = options.onSuggestion;
    this.now = options.now ?? (() => Date.now());
  }

  handleUtterance(text: string): void {
    this.pendingText = text;
    if (this.running) return;
    this.running = true;
    this.runPromise = this.drain();
  }

  noteDismissed(): void {
    this.dismissedUntil = this.now() + DISMISS_COOLDOWN_MS;
  }

  /** Test helper: resolves once the queue has fully drained. */
  async idle(): Promise<void> {
    if (this.runPromise) {
      await this.runPromise;
    }
  }

  private async drain(): Promise<void> {
    while (this.pendingText !== null) {
      this.pendingText = null;
      await this.classifyOnce();
    }
    this.running = false;
  }

  private async classifyOnce(): Promise<void> {
    try {
      if (this.now() < this.dismissedUntil) return;

      const window = this.store.recentWindow(WINDOW_MAX_WORDS);
      const user = formatWindow(window);
      const system = `${SYSTEM_PROMPT_PREFIX}${localIsoDateTime(this.now())}${SYSTEM_PROMPT_SUFFIX}`;

      const raw = await this.ollama.chatJSON(system, user, TRIGGER_SCHEMA);
      const parsed = parseTriggerResult(raw);
      if (!parsed) return;
      if (!parsed.trigger || parsed.confidence < CONFIDENCE_THRESHOLD) return;

      // Re-check dismissal: a chatJSON round trip can take long enough for a
      // dismissal to land while this classification was in flight.
      const fireNow = this.now();
      if (fireNow < this.dismissedUntil) return;

      const vector = await this.ollama.embed(parsed.suggestion);
      this.pruneRecentSuggestions(fireNow);
      if (this.isDuplicateSuggestion(vector, parsed.suggestion)) return;

      this.recentSuggestions.push({ vector, text: parsed.suggestion, at: fireNow });
      this.onSuggestion({
        kind: parsed.kind,
        confidence: parsed.confidence,
        suggestion: parsed.suggestion,
        payload: parsed.payload,
      });
    } catch {
      // Never throw out of the background runner: a rejection here would be
      // unhandled and could crash the main process.
    }
  }

  private pruneRecentSuggestions(now: number): void {
    const cutoff = now - DEDUPE_WINDOW_MS;
    this.recentSuggestions = this.recentSuggestions.filter((entry) => entry.at >= cutoff);
  }

  private isDuplicateSuggestion(vector: Float32Array | null, text: string): boolean {
    const lower = text.toLowerCase();
    for (const entry of this.recentSuggestions) {
      if (vector !== null && entry.vector !== null) {
        if (cosineSimilarity(vector, entry.vector) > DEDUPE_COSINE_THRESHOLD) return true;
      } else if (entry.text.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }
}
