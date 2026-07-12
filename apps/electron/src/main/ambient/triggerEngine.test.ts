// apps/electron/src/main/ambient/triggerEngine.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memoryStore";
import type { OllamaClient } from "./ollama";
import { TriggerEngine, type TriggerSuggestion } from "./triggerEngine";

function unitVector(seed: number): Float32Array {
  const v = new Float32Array(768);
  v[0] = seed;
  v[1] = 1;
  return v;
}

function stubOllama(overrides: Partial<OllamaClient> = {}): OllamaClient {
  return {
    embedModel: "nomic-embed-text",
    embed: vi.fn().mockResolvedValue(unitVector(1)),
    chatJSON: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function triggerResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    trigger: true,
    kind: "reminder",
    confidence: 0.9,
    suggestion: "Create a reminder: Jonas's party, Saturday July 18?",
    payload: { title: "Jonas's party", due: "2026-07-18T00:00:00" },
    ...overrides,
  };
}

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore(":memory:");
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
});

describe("TriggerEngine", () => {
  it("fires onSuggestion when chatJSON returns trigger:true with confidence >= 0.7", async () => {
    store.addUtterance("we need to plan Jonas's party for Saturday", "ambient");
    const ollama = stubOllama({
      chatJSON: vi.fn().mockResolvedValue(triggerResult()),
    });
    const onSuggestion = vi.fn<(s: TriggerSuggestion) => void>();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    engine.handleUtterance("we need to plan Jonas's party for Saturday");
    await engine.idle();

    expect(onSuggestion).toHaveBeenCalledTimes(1);
    expect(onSuggestion).toHaveBeenCalledWith({
      kind: "reminder",
      confidence: 0.9,
      suggestion: "Create a reminder: Jonas's party, Saturday July 18?",
      payload: { title: "Jonas's party", due: "2026-07-18T00:00:00" },
    });
  });

  it("does not fire when confidence is below 0.7", async () => {
    store.addUtterance("just chatting", "ambient");
    const ollama = stubOllama({
      chatJSON: vi.fn().mockResolvedValue(triggerResult({ confidence: 0.5 })),
    });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    engine.handleUtterance("just chatting");
    await engine.idle();

    expect(onSuggestion).not.toHaveBeenCalled();
  });

  it("does not fire when trigger is false", async () => {
    store.addUtterance("just chatting", "ambient");
    const ollama = stubOllama({
      chatJSON: vi.fn().mockResolvedValue(triggerResult({ trigger: false, confidence: 0.95 })),
    });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    engine.handleUtterance("just chatting");
    await engine.idle();

    expect(onSuggestion).not.toHaveBeenCalled();
  });

  it("latest-wins: 3 rapid handleUtterance calls while chatJSON hangs make at most 2 LLM calls", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const chatJSON = vi.fn<OllamaClient["chatJSON"]>(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const ollama = stubOllama({ chatJSON });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    store.addUtterance("text one", "ambient");
    engine.handleUtterance("text one");
    store.addUtterance("text two", "ambient");
    engine.handleUtterance("text two");
    store.addUtterance("text three", "ambient");
    engine.handleUtterance("text three");

    expect(chatJSON).toHaveBeenCalledTimes(1);
    resolvers[0]!(null);
    await vi.waitFor(() => expect(chatJSON).toHaveBeenCalledTimes(2));

    // The second (final) call's window must reflect the latest store state.
    const secondUserMsg = chatJSON.mock.calls[1]![1] as string;
    expect(secondUserMsg).toContain("text three");

    resolvers[1]!(null);
    await engine.idle();

    expect(chatJSON).toHaveBeenCalledTimes(2);
  });

  it("dedupes: same suggestion embedded twice within 60 min fires onSuggestion once", async () => {
    store.addUtterance("we need to plan Jonas's party", "ambient");
    const ollama = stubOllama({
      chatJSON: vi.fn().mockResolvedValue(triggerResult()),
      embed: vi.fn().mockResolvedValue(unitVector(1)),
    });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    engine.handleUtterance("we need to plan Jonas's party");
    await engine.idle();
    engine.handleUtterance("we need to plan Jonas's party again");
    await engine.idle();

    expect(onSuggestion).toHaveBeenCalledTimes(1);
  });

  it("dedupes on lowercased string equality when embed returns null", async () => {
    store.addUtterance("we need to plan Jonas's party", "ambient");
    const ollama = stubOllama({
      chatJSON: vi.fn().mockResolvedValue(triggerResult()),
      embed: vi.fn().mockResolvedValue(null),
    });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    engine.handleUtterance("we need to plan Jonas's party");
    await engine.idle();
    engine.handleUtterance("we need to plan Jonas's party again");
    await engine.idle();

    expect(onSuggestion).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe distinct suggestions with dissimilar embeddings", async () => {
    store.addUtterance("we need to plan Jonas's party", "ambient");
    let call = 0;
    const ollama = stubOllama({
      chatJSON: vi.fn().mockImplementation(() => {
        call += 1;
        return Promise.resolve(
          triggerResult({ suggestion: `suggestion number ${call}` }),
        );
      }),
      embed: vi.fn().mockImplementation((text: string) => {
        // Orthogonal vectors -> cosine similarity 0, well under the 0.85 threshold.
        const v = new Float32Array(768);
        v[text.endsWith("1") ? 0 : 1] = 1;
        return Promise.resolve(v);
      }),
    });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    engine.handleUtterance("first");
    await engine.idle();
    engine.handleUtterance("second");
    await engine.idle();

    expect(onSuggestion).toHaveBeenCalledTimes(2);
  });

  it("noteDismissed() suppresses triggers for 2 minutes, then resumes", async () => {
    let now = 1_000_000;
    store.addUtterance("we need to plan Jonas's party", "ambient");
    const ollama = stubOllama({
      chatJSON: vi.fn().mockResolvedValue(triggerResult()),
    });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion, now: () => now });

    engine.noteDismissed();
    engine.handleUtterance("we need to plan Jonas's party");
    await engine.idle();
    expect(onSuggestion).not.toHaveBeenCalled();

    now += 121_000;
    engine.handleUtterance("we need to plan Jonas's party");
    await engine.idle();
    expect(onSuggestion).toHaveBeenCalledTimes(1);
  });

  it("a null chatJSON response does not fire and does not throw", async () => {
    store.addUtterance("we need to plan Jonas's party", "ambient");
    const ollama = stubOllama({ chatJSON: vi.fn().mockResolvedValue(null) });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    expect(() => engine.handleUtterance("we need to plan Jonas's party")).not.toThrow();
    await expect(engine.idle()).resolves.toBeUndefined();
    expect(onSuggestion).not.toHaveBeenCalled();
  });

  it("a malformed chatJSON response does not fire and does not throw", async () => {
    store.addUtterance("we need to plan Jonas's party", "ambient");
    const ollama = stubOllama({
      chatJSON: vi.fn().mockResolvedValue({ trigger: true, confidence: "high" }),
    });
    const onSuggestion = vi.fn();
    const engine = new TriggerEngine({ store, ollama, onSuggestion });

    engine.handleUtterance("we need to plan Jonas's party");
    await expect(engine.idle()).resolves.toBeUndefined();
    expect(onSuggestion).not.toHaveBeenCalled();
  });

  it("idle() resolves immediately when handleUtterance was never called", async () => {
    const ollama = stubOllama();
    const engine = new TriggerEngine({ store, ollama, onSuggestion: vi.fn() });

    await expect(engine.idle()).resolves.toBeUndefined();
  });

  it("formats the user message as recentWindow lines newest-last and passes a system prompt with the local datetime", async () => {
    const ts = Date.parse("2026-07-11T15:04:00");
    store.addUtterance("hello there", "ambient", ts);
    const chatJSON = vi.fn().mockResolvedValue(null);
    const ollama = stubOllama({ chatJSON });
    const engine = new TriggerEngine({ store, ollama, onSuggestion: vi.fn(), now: () => ts });

    engine.handleUtterance("hello there");
    await engine.idle();

    expect(chatJSON).toHaveBeenCalledTimes(1);
    const [system, user, schema] = chatJSON.mock.calls[0]!;
    expect(user).toContain("hello there");
    expect(system).toContain("2026-07-11");
    expect(schema).toMatchObject({
      required: ["trigger", "kind", "confidence", "suggestion", "payload"],
    });
  });
});
