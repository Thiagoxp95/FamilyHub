// apps/electron/src/main/ambient/factsDigest.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memoryStore";
import type { OllamaClient } from "./ollama";
import { runDigest, scheduleDigest, shouldRunDigest } from "./factsDigest";

const DAY_MS = 24 * 60 * 60 * 1000;

function stubOllama(chatJSON: OllamaClient["chatJSON"]): OllamaClient {
  return {
    embed: vi.fn().mockResolvedValue(null),
    chatJSON,
    embedModel: "test-model",
  };
}

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("runDigest", () => {
  it("stores facts with expiry = model date + 7 days, and null expiry stays null", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    store.addUtterance("dentist appointment next tuesday", "ambient", now - 60_000);
    store.addUtterance("James likes oat milk", "ambient", now - 30_000);

    const chatJSON = vi.fn().mockResolvedValue({
      facts: [
        // "Event" 3 days ago relative to `now` — without the +7 day grace
        // period this would already be expired at `now`.
        { text: "dentist appointment", expiresAt: "2026-07-08" },
        { text: "James likes oat milk", expiresAt: null },
      ],
    });
    const ollama = stubOllama(chatJSON);

    const added = await runDigest(store, ollama, now);

    expect(added).toBe(2);
    const eventHit = store.search(null, "dentist", { layer: "fact" });
    expect(eventHit).toHaveLength(1);

    const preferenceHit = store.search(null, "oat milk", { layer: "fact" });
    expect(preferenceHit).toHaveLength(1);
  });

  it("advances meta.lastDigestTs to `now` on full success", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    store.addUtterance("hello", "ambient", now - 1000);
    const chatJSON = vi.fn().mockResolvedValue({ facts: [] });
    const ollama = stubOllama(chatJSON);

    await runDigest(store, ollama, now);

    expect(store.getMeta("lastDigestTs")).toBe(String(now));
  });

  it("returns the count of facts added", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    store.addUtterance("hello", "ambient", now - 1000);
    const chatJSON = vi.fn().mockResolvedValue({
      facts: [
        { text: "fact one", expiresAt: null },
        { text: "fact two", expiresAt: null },
        { text: "fact three", expiresAt: null },
      ],
    });
    const ollama = stubOllama(chatJSON);

    const added = await runDigest(store, ollama, now);

    expect(added).toBe(3);
  });

  it("a null chatJSON response yields 0 facts for that chunk and does NOT advance lastDigestTs", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    store.addUtterance("hello", "ambient", now - 1000);
    store.setMeta("lastDigestTs", String(now - DAY_MS));
    const chatJSON = vi.fn().mockResolvedValue(null);
    const ollama = stubOllama(chatJSON);

    const added = await runDigest(store, ollama, now);

    expect(added).toBe(0);
    expect(store.getMeta("lastDigestTs")).toBe(String(now - DAY_MS));
  });

  it("reads utterances since meta.lastDigestTs, defaulting to 24h ago when unset", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    store.addUtterance("too old to include", "ambient", now - DAY_MS - 60_000);
    store.addUtterance("within window", "ambient", now - 1000);
    const chatJSON = vi.fn().mockResolvedValue({ facts: [] });
    const ollama = stubOllama(chatJSON);

    await runDigest(store, ollama, now);

    expect(chatJSON).toHaveBeenCalledTimes(1);
    const userArg = chatJSON.mock.calls[0]![1] as string;
    expect(userArg).toContain("within window");
    expect(userArg).not.toContain("too old to include");
  });

  it("injects the current ISO date into the system prompt", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    store.addUtterance("hello", "ambient", now - 1000);
    const chatJSON = vi.fn().mockResolvedValue({ facts: [] });
    const ollama = stubOllama(chatJSON);

    await runDigest(store, ollama, now);

    const systemArg = chatJSON.mock.calls[0]![0] as string;
    expect(systemArg).toContain("2026-07-11");
  });

  it("chunks utterances into batches of at most 4000 words, one chatJSON call per chunk", async () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    const bigText = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
    store.addUtterance(bigText, "ambient", now - 3000);
    store.addUtterance(bigText, "ambient", now - 2000);
    const chatJSON = vi.fn().mockResolvedValue({ facts: [] });
    const ollama = stubOllama(chatJSON);

    await runDigest(store, ollama, now);

    expect(chatJSON).toHaveBeenCalledTimes(2);
  });
});

describe("shouldRunDigest", () => {
  function localTime(hour: number, minute: number, dayOffset = 0): number {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  }

  it("never ran, now past 03:30 -> true", () => {
    const now = localTime(4, 0);
    expect(shouldRunDigest(null, now)).toBe(true);
  });

  it("ran yesterday, now 04:00 -> true", () => {
    const lastTs = localTime(10, 0, -1);
    const now = localTime(4, 0);
    expect(shouldRunDigest(lastTs, now)).toBe(true);
  });

  it("ran today at 03:35, now 09:00 -> false", () => {
    const lastTs = localTime(3, 35);
    const now = localTime(9, 0);
    expect(shouldRunDigest(lastTs, now)).toBe(false);
  });

  it("now 02:00, ran yesterday -> false", () => {
    const lastTs = localTime(10, 0, -1);
    const now = localTime(2, 0);
    expect(shouldRunDigest(lastTs, now)).toBe(false);
  });
});

describe("scheduleDigest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a catch-up digest at startup when more than 26h have passed, and returns a working cancel()", async () => {
    store.addUtterance("hello", "ambient", Date.now() - 1000);
    const chatJSON = vi.fn().mockResolvedValue({ facts: [] });
    const ollama = stubOllama(chatJSON);

    const cancel = scheduleDigest(store, ollama);
    await vi.waitFor(() => expect(chatJSON).toHaveBeenCalledTimes(1));

    cancel();
    chatJSON.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(chatJSON).not.toHaveBeenCalled();
  });

  it("does not run a catch-up digest when lastDigestTs is recent", async () => {
    store.setMeta("lastDigestTs", String(Date.now() - 1000));
    const chatJSON = vi.fn().mockResolvedValue({ facts: [] });
    const ollama = stubOllama(chatJSON);

    const cancel = scheduleDigest(store, ollama);
    await vi.advanceTimersByTimeAsync(1000);

    expect(chatJSON).not.toHaveBeenCalled();
    cancel();
  });
});
