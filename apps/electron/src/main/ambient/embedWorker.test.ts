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

  it("tick resolves and counts only successful embeds when setEmbedding throws", async () => {
    if (!store.vectorSearchAvailable) return;
    store.addUtterance("first", "ambient", 1000);
    store.addUtterance("second", "ambient", 2000);
    const ollama = stubOllama();
    let calls = 0;
    vi.spyOn(store, "setEmbedding").mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("SQLITE_BUSY");
    });
    const worker = new EmbedWorker({ store, ollama });

    await expect(worker.tick()).resolves.toBe(1);
  });

  it("tick resolves 0 when pendingEmbeddings throws", async () => {
    const ollama = stubOllama();
    vi.spyOn(store, "pendingEmbeddings").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    const worker = new EmbedWorker({ store, ollama });

    await expect(worker.tick()).resolves.toBe(0);
    expect(ollama.embed).not.toHaveBeenCalled();
  });

  it("skips overlapping ticks while an embed is still in flight", async () => {
    if (!store.vectorSearchAvailable) return;
    store.addUtterance("slow one", "ambient");
    let resolveEmbed!: (v: Float32Array | null) => void;
    const ollama = stubOllama({
      embed: vi.fn(
        () =>
          new Promise<Float32Array | null>((resolve) => {
            resolveEmbed = resolve;
          }),
      ),
    });
    const pendingSpy = vi.spyOn(store, "pendingEmbeddings");
    const worker = new EmbedWorker({ store, ollama });

    const first = worker.tick();
    const second = worker.tick();

    await expect(second).resolves.toBe(0);
    expect(pendingSpy).toHaveBeenCalledTimes(1);

    resolveEmbed(unitVector());
    await expect(first).resolves.toBe(1);

    // once the in-flight tick finishes, the next tick runs normally
    await worker.tick();
    expect(pendingSpy).toHaveBeenCalledTimes(2);
  });

  it("interval firings while a tick is in flight do not re-fetch pending rows", async () => {
    if (!store.vectorSearchAvailable) return;
    vi.useFakeTimers();
    store.addUtterance("slow one", "ambient");
    let resolveEmbed!: (v: Float32Array | null) => void;
    const ollama = stubOllama({
      embed: vi.fn(
        () =>
          new Promise<Float32Array | null>((resolve) => {
            resolveEmbed = resolve;
          }),
      ),
    });
    const pendingSpy = vi.spyOn(store, "pendingEmbeddings");
    const worker = new EmbedWorker({ store, ollama, intervalMs: 1000 });

    worker.start();
    await vi.advanceTimersByTimeAsync(1000); // first tick starts, embed hangs
    await vi.advanceTimersByTimeAsync(3000); // three more firings while in flight

    expect(pendingSpy).toHaveBeenCalledTimes(1);

    resolveEmbed(unitVector());
    await vi.advanceTimersByTimeAsync(1000); // next firing after completion runs
    expect(pendingSpy).toHaveBeenCalledTimes(2);

    worker.stop();
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
