// apps/electron/src/main/ambient/suggestionService.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveStateEvent, ToolRunner } from "../assistant/liveController";
import { MemoryStore } from "./memoryStore";
import { SuggestionService } from "./suggestionService";
import type { TriggerSuggestion } from "./triggerEngine";

function suggestionFixture(overrides: Partial<TriggerSuggestion> = {}): TriggerSuggestion {
  return {
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

function makeService(overrides: {
  sendLive?: ReturnType<typeof vi.fn<(event: LiveStateEvent) => void>>;
  runTool?: ReturnType<typeof vi.fn<ToolRunner>>;
  onDismissed?: ReturnType<typeof vi.fn<() => void>>;
  timeoutMs?: number;
} = {}) {
  const sendLive = overrides.sendLive ?? vi.fn<(event: LiveStateEvent) => void>();
  const runTool =
    overrides.runTool ?? vi.fn<ToolRunner>().mockResolvedValue({ ok: true });
  const onDismissed = overrides.onDismissed ?? vi.fn<() => void>();
  const setStatus = vi.spyOn(store, "setSuggestionStatus");
  const options: ConstructorParameters<typeof SuggestionService>[0] = {
    store,
    sendLive,
    runTool,
    onDismissed,
  };
  if (overrides.timeoutMs !== undefined) {
    options.timeoutMs = overrides.timeoutMs;
  }
  const service = new SuggestionService(options);
  return { service, sendLive, runTool, onDismissed, setStatus };
}

function shownId(sendLive: ReturnType<typeof vi.fn<(event: LiveStateEvent) => void>>): number {
  const call = sendLive.mock.calls.find((c) => (c[0] as { type: string }).type === "suggestion");
  return (call![0] as { id: number }).id;
}

describe("SuggestionService", () => {
  it("show() sends a suggestion live event and writes a store row", () => {
    const { service, sendLive } = makeService();

    service.show(suggestionFixture());

    expect(sendLive).toHaveBeenCalledWith({
      type: "suggestion",
      id: expect.any(Number),
      kind: "reminder",
      text: "Create a reminder: Jonas's party, Saturday July 18?",
    });

    const rows = store.recentSuggestions(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("Create a reminder: Jonas's party, Saturday July 18?");
  });

  it("auto-expires after timeoutMs: sends suggestionResolved expired and persists status", () => {
    vi.useFakeTimers();
    const { service, sendLive, setStatus } = makeService({ timeoutMs: 30_000 });

    service.show(suggestionFixture());
    const id = shownId(sendLive);
    sendLive.mockClear();

    vi.advanceTimersByTime(30_000);

    expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "expired" });
    expect(setStatus).toHaveBeenCalledWith(id, "expired");
  });

  it("does not auto-expire before timeoutMs elapses", () => {
    vi.useFakeTimers();
    const { service, sendLive } = makeService({ timeoutMs: 30_000 });

    service.show(suggestionFixture());
    sendLive.mockClear();

    vi.advanceTimersByTime(29_999);

    expect(sendLive).not.toHaveBeenCalled();
  });

  describe("accept()", () => {
    it("runs create_reminder for a reminder suggestion and resolves accepted", async () => {
      const { service, sendLive, runTool, setStatus } = makeService();

      service.show(
        suggestionFixture({
          kind: "reminder",
          payload: { title: "Jonas's party", due: "2026-07-18T00:00:00" },
        }),
      );
      const id = shownId(sendLive);

      await service.accept(id);

      expect(runTool).toHaveBeenCalledWith("create_reminder", {
        title: "Jonas's party",
        due: "2026-07-18T00:00:00",
      });
      expect(setStatus).toHaveBeenCalledWith(id, "accepted");
      expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "accepted" });
    });

    it("runs create_event for a calendar suggestion, mapping payload.due to start", async () => {
      const { service, sendLive, runTool } = makeService();

      service.show(
        suggestionFixture({
          kind: "calendar",
          payload: { title: "Dentist", due: "2026-07-20T09:00:00" },
        }),
      );
      const id = shownId(sendLive);

      await service.accept(id);

      expect(runTool).toHaveBeenCalledWith("create_event", {
        title: "Dentist",
        start: "2026-07-20T09:00:00",
      });
      expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "accepted" });
    });

    it("runs create_reminder with 'Buy <item>' + Groceries list for a shopping suggestion", async () => {
      const { service, sendLive, runTool } = makeService();

      service.show(
        suggestionFixture({
          kind: "shopping",
          payload: { item: "milk" },
        }),
      );
      const id = shownId(sendLive);

      await service.accept(id);

      expect(runTool).toHaveBeenCalledWith("create_reminder", {
        title: "Buy milk",
        list: "Groceries",
      });
      expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "accepted" });
    });

    it("runs no tool for question/other suggestions but still resolves accepted", async () => {
      const { service, sendLive, runTool, setStatus } = makeService();

      service.show(suggestionFixture({ kind: "question", payload: { question: "who won?" } }));
      const id = shownId(sendLive);

      await service.accept(id);

      expect(runTool).not.toHaveBeenCalled();
      expect(setStatus).toHaveBeenCalledWith(id, "accepted");
      expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "accepted" });
    });

    it("still resolves accepted when runTool throws (never leaves the service wedged)", async () => {
      const runTool = vi.fn<ToolRunner>().mockRejectedValue(new Error("boom"));
      const { service, sendLive, setStatus } = makeService({ runTool });

      service.show(suggestionFixture());
      const id = shownId(sendLive);

      await expect(service.accept(id)).resolves.toBeUndefined();

      expect(setStatus).toHaveBeenCalledWith(id, "accepted");
      expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "accepted" });

      // The service is still usable afterwards.
      sendLive.mockClear();
      service.show(suggestionFixture({ suggestion: "next one" }));
      expect(sendLive).toHaveBeenCalledWith(
        expect.objectContaining({ type: "suggestion", text: "next one" }),
      );
    });

    it("is a no-op for a stale id that is no longer the visible card", async () => {
      const { service, sendLive, runTool } = makeService();

      service.show(suggestionFixture());
      const id = shownId(sendLive);
      service.dismiss(id);
      runTool.mockClear();

      await service.accept(id);

      expect(runTool).not.toHaveBeenCalled();
    });
  });

  describe("dismiss()", () => {
    it("resolves the card as dismissed and calls onDismissed", () => {
      const { service, sendLive, onDismissed, setStatus } = makeService();

      service.show(suggestionFixture());
      const id = shownId(sendLive);

      service.dismiss(id);

      expect(setStatus).toHaveBeenCalledWith(id, "dismissed");
      expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "dismissed" });
      expect(onDismissed).toHaveBeenCalledTimes(1);
    });

    it("is a no-op for a stale/unknown id", () => {
      const { service, onDismissed } = makeService();

      service.dismiss(999);

      expect(onDismissed).not.toHaveBeenCalled();
    });
  });

  describe("handleVoice()", () => {
    it('accepts the visible card on "sure james"', async () => {
      const { service, sendLive, runTool, setStatus } = makeService();

      service.show(suggestionFixture());
      const id = shownId(sendLive);

      service.handleVoice("sure james, go ahead");

      await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(id, "accepted"));
      expect(runTool).toHaveBeenCalled();
    });

    it('accepts the visible card on "james yes"', async () => {
      const { service, sendLive, runTool } = makeService();

      service.show(suggestionFixture());
      shownId(sendLive);

      service.handleVoice("james, yes please");

      await vi.waitFor(() => expect(runTool).toHaveBeenCalled());
    });

    it("does nothing for unrelated speech", () => {
      const { service, runTool, setStatus } = makeService();

      service.show(suggestionFixture());
      service.handleVoice("what's the weather like today");

      expect(runTool).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("does nothing when no card is visible", () => {
      const { service, runTool } = makeService();

      service.handleVoice("sure james");

      expect(runTool).not.toHaveBeenCalled();
    });
  });

  describe("store write resilience", () => {
    it("expiry timer fires without crashing when setSuggestionStatus throws, and still emits the resolve event", () => {
      vi.useFakeTimers();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { service, sendLive, setStatus } = makeService({ timeoutMs: 30_000 });
      setStatus.mockImplementation(() => {
        throw new Error("disk full");
      });

      service.show(suggestionFixture());
      const id = shownId(sendLive);
      sendLive.mockClear();

      // The throw happens inside a plain setTimeout callback — if unguarded it
      // would be an uncaught exception and crash the main process.
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();

      expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id, status: "expired" });
      consoleError.mockRestore();
    });

    it("show() degrades without throwing when addSuggestion throws", () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { service, sendLive } = makeService();
      vi.spyOn(store, "addSuggestion").mockImplementation(() => {
        throw new Error("disk full");
      });

      expect(() => service.show(suggestionFixture())).not.toThrow();
      expect(sendLive).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "suggestion" }),
      );
      consoleError.mockRestore();
    });

    it("logs the first store-write failure only (repeat failures stay quiet)", () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { service, sendLive, setStatus } = makeService();
      setStatus.mockImplementation(() => {
        throw new Error("disk full");
      });

      service.show(suggestionFixture());
      service.dismiss(shownId(sendLive));
      sendLive.mockClear();
      service.show(suggestionFixture({ suggestion: "second" }));
      service.dismiss(shownId(sendLive));

      const storeFailureLogs = consoleError.mock.calls.filter((c) =>
        String(c[0]).includes("store write failed"),
      );
      expect(storeFailureLogs).toHaveLength(1);
      consoleError.mockRestore();
    });
  });

  it("logs a traceable line when the accept tool call fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runTool = vi.fn<ToolRunner>().mockRejectedValue(new Error("AppleScript timed out"));
    const { service, sendLive } = makeService({ runTool });

    service.show(suggestionFixture());
    await service.accept(shownId(sendLive));

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AppleScript timed out"),
    );
    consoleError.mockRestore();
  });

  it("logs a traceable line when runTool resolves ok:false (no throw) — the silent-failure case", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runTool = vi.fn<ToolRunner>().mockResolvedValue({ ok: false, error: "denied" });
    const { service, sendLive, setStatus } = makeService({ runTool });

    service.show(suggestionFixture());
    await service.accept(shownId(sendLive));

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("denied"),
    );
    // The card must still resolve "accepted" — status enum unchanged.
    expect(setStatus).toHaveBeenCalledWith(expect.any(Number), "accepted");
    consoleError.mockRestore();
  });

  it("does not log when runTool resolves ok:true", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runTool = vi.fn<ToolRunner>().mockResolvedValue({ ok: true });
    const { service, sendLive } = makeService({ runTool });

    service.show(suggestionFixture());
    await service.accept(shownId(sendLive));

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("a second show() while one is visible expires the first", () => {
    vi.useFakeTimers();
    const { service, sendLive, setStatus } = makeService();

    service.show(suggestionFixture({ suggestion: "first" }));
    const firstId = shownId(sendLive);
    sendLive.mockClear();

    service.show(suggestionFixture({ suggestion: "second" }));
    const secondId = shownId(sendLive);

    expect(firstId).not.toBe(secondId);
    expect(sendLive).toHaveBeenCalledWith({ type: "suggestionResolved", id: firstId, status: "expired" });
    expect(sendLive).toHaveBeenCalledWith({
      type: "suggestion",
      id: secondId,
      kind: "reminder",
      text: "second",
    });
    expect(setStatus).toHaveBeenCalledWith(firstId, "expired");

    // The replaced card's timer must not also fire later (no duplicate resolve).
    sendLive.mockClear();
    vi.advanceTimersByTime(30_000);
    const resolvedForFirst = sendLive.mock.calls.filter(
      (c) => (c[0] as { type: string; id?: number }).id === firstId,
    );
    expect(resolvedForFirst).toHaveLength(0);
  });
});
