// apps/electron/src/main/ambient/embedWorker.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memoryStore";
import { EmbedWorker } from "./embedWorker";
import type { OllamaClient } from "./ollama";

function unitVector(): Float32Array {
  const v = new Float32Array(768);
  v[0] = 1;
  return v;
}

function stubOllama(overrides: Partial<OllamaClient> = {}): OllamaClient {
  return {
    embedModel: "nomic-embed-text",
    embed: vi.fn().mockResolvedValue(unitVector()),
    chatJSON: vi.fn().mockResolvedValue(null),
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

describe("EmbedWorker", () => {
  it("tick() embeds pending rows and marks them non-pending", async () => {
    if (!store.vectorSearchAvailable) return;
    store.addUtterance("hello world", "ambient");
    store.addUtterance("goodbye world", "ambient");
    const ollama = stubOllama();
    const worker = new EmbedWorker({ store, ollama });

    const count = await worker.tick();

    expect(count).toBe(2);
    expect(store.pendingEmbeddings(16)).toEqual([]);
  });

  it("a null embed leaves the row pending and does not throw", async () => {
    if (!store.vectorSearchAvailable) return;
    store.addUtterance("hello world", "ambient");
    const ollama = stubOllama({ embed: vi.fn().mockResolvedValue(null) });
    const worker = new EmbedWorker({ store, ollama });

    await expect(worker.tick()).resolves.toBe(0);
    expect(store.pendingEmbeddings(16)).toHaveLength(1);
  });

  it("tick() processes at most 16 pending rows", async () => {
    if (!store.vectorSearchAvailable) return;
    for (let i = 0; i < 20; i++) {
      store.addUtterance(`utterance ${i}`, "ambient");
    }
    const ollama = stubOllama();
    const worker = new EmbedWorker({ store, ollama });

    const count = await worker.tick();

    expect(count).toBe(16);
    expect(store.pendingEmbeddings(16)).toHaveLength(4);
  });

  it("tick() returns 0 when there is nothing pending", async () => {
    const ollama = stubOllama();
    const worker = new EmbedWorker({ store, ollama });

    const count = await worker.tick();

    expect(count).toBe(0);
  });

  it("start() runs tick on the configured interval, stop() halts it", () => {
    vi.useFakeTimers();
    const ollama = stubOllama();
    const worker = new EmbedWorker({ store, ollama, intervalMs: 1000 });
    const tickSpy = vi.spyOn(worker, "tick").mockResolvedValue(0);

    worker.start();
    expect(tickSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(tickSpy).toHaveBeenCalledTimes(3);

    worker.stop();
    vi.advanceTimersByTime(5000);
    expect(tickSpy).toHaveBeenCalledTimes(3);
  });

  it("start() is idempotent when called twice", () => {
    vi.useFakeTimers();
    const ollama = stubOllama();
    const worker = new EmbedWorker({ store, ollama, intervalMs: 1000 });
    const tickSpy = vi.spyOn(worker, "tick").mockResolvedValue(0);

    worker.start();
    worker.start();
    vi.advanceTimersByTime(1000);

    expect(tickSpy).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it("stop() before start() is a no-op", () => {
    const ollama = stubOllama();
    const worker = new EmbedWorker({ store, ollama });
    expect(() => worker.stop()).not.toThrow();
  });

  it("defaults intervalMs to 15000", () => {
    vi.useFakeTimers();
    const ollama = stubOllama();
    const worker = new EmbedWorker({ store, ollama });
    const tickSpy = vi.spyOn(worker, "tick").mockResolvedValue(0);

    worker.start();
    vi.advanceTimersByTime(14999);
    expect(tickSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    worker.stop();
  });
});
