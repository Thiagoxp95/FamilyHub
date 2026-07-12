// apps/electron/src/main/ambient/memoryStore.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore";

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("MemoryStore", () => {
  it("construction never throws and reports vector search availability", () => {
    expect(typeof store.vectorSearchAvailable).toBe("boolean");
  });

  it("addUtterance returns a numeric id and defaults ts to now", () => {
    const before = Date.now();
    const id = store.addUtterance("hello there", "ambient");
    const after = Date.now();
    expect(typeof id).toBe("number");
    const [u] = store.recentWindow(10);
    expect(u).toBeDefined();
    expect(u!.ts).toBeGreaterThanOrEqual(before);
    expect(u!.ts).toBeLessThanOrEqual(after);
    expect(u!.source).toBe("ambient");
    expect(u!.speaker).toBeNull();
  });

  it("stores and windows utterances oldest→newest capped by word count", () => {
    store.addUtterance("one two three", "ambient", 1000);
    store.addUtterance("four five", "ambient", 2000);
    store.addUtterance("six seven eight nine", "ambient", 3000);
    const window = store.recentWindow(7);
    expect(window.map((u) => u.text)).toEqual(["four five", "six seven eight nine"]);
  });

  it("recentWindow returns everything oldest->newest when under the cap", () => {
    store.addUtterance("a", "ambient", 1000);
    store.addUtterance("b", "session_user", 2000);
    store.addUtterance("c", "session_james", 3000);
    const window = store.recentWindow(1000);
    expect(window.map((u) => u.text)).toEqual(["a", "b", "c"]);
  });

  it("backfills embeddings and reports pending", () => {
    const id = store.addUtterance("hello", "ambient");
    if (!store.vectorSearchAvailable) return;
    expect(store.pendingEmbeddings(10)).toEqual([{ table: "utterances", id, text: "hello" }]);
    store.setEmbedding("utterances", id, unitVector(0), "test-model");
    expect(store.pendingEmbeddings(10)).toEqual([]);
  });

  it("pendingEmbeddings returns [] when vector search is unavailable", () => {
    if (store.vectorSearchAvailable) return;
    store.addUtterance("hello", "ambient");
    expect(store.pendingEmbeddings(10)).toEqual([]);
  });

  it("pendingEmbeddings includes facts after utterances, oldest first", () => {
    if (!store.vectorSearchAvailable) return;
    const u = store.addUtterance("hello", "ambient", 1000);
    const f = store.addFact("hello fact", [u], null);
    store.setEmbedding("utterances", u, unitVector(0), "m");
    const pending = store.pendingEmbeddings(10);
    expect(pending).toEqual([{ table: "facts", id: f, text: "hello fact" }]);
  });

  it("vector-searches when embeddings exist", () => {
    if (!store.vectorSearchAvailable) return;
    const a = store.addUtterance("jonas party saturday", "ambient");
    const b = store.addUtterance("the oven is broken", "ambient");
    store.setEmbedding("utterances", a, unitVector(0), "m");
    store.setEmbedding("utterances", b, unitVector(1), "m");
    const hits = store.search(unitVector(0), "party", { layer: "raw", topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(a);
  });

  it("falls back to LIKE search without a query vector", () => {
    store.addUtterance("jonas party saturday", "ambient");
    const hits = store.search(null, "party");
    expect(hits.some((h) => h.text.includes("party"))).toBe(true);
  });

  it("LIKE search respects topK and sinceTs", () => {
    store.addUtterance("party one", "ambient", 1000);
    store.addUtterance("party two", "ambient", 2000);
    store.addUtterance("party three", "ambient", 3000);
    const hits = store.search(null, "party", { sinceTs: 1500, topK: 5 });
    expect(hits.map((h) => h.text).sort()).toEqual(["party three", "party two"]);
  });

  it("facts layer: excludes expired facts from search", () => {
    const u = store.addUtterance("x", "ambient");
    store.addFact("party on saturday", [u], Date.now() - 1); // already expired
    const hits = store.search(null, "party", { layer: "fact" });
    expect(hits).toEqual([]);
  });

  it("facts layer: includes non-expired and never-expiring facts", () => {
    const u = store.addUtterance("x", "ambient");
    store.addFact("party forever", [u], null);
    store.addFact("party tomorrow", [u], Date.now() + 100000);
    const hits = store.search(null, "party", { layer: "fact" });
    expect(hits.map((h) => h.text).sort()).toEqual(["party forever", "party tomorrow"]);
    expect(hits.every((h) => h.layer === "fact")).toBe(true);
  });

  it("layer 'both' returns facts before distinct raw utterances", () => {
    const u = store.addUtterance("party planning notes", "ambient");
    store.addFact("party is confirmed for saturday", [u], null);
    const hits = store.search(null, "party", { layer: "both" });
    expect(hits.some((h) => h.layer === "fact")).toBe(true);
    expect(hits.some((h) => h.layer === "raw")).toBe(true);
    const factIndex = hits.findIndex((h) => h.layer === "fact");
    const rawIndex = hits.findIndex((h) => h.layer === "raw");
    expect(factIndex).toBeLessThan(rawIndex);
  });

  it("layer 'both' de-duplicates a raw hit whose text matches a fact hit", () => {
    const u = store.addUtterance("party planning notes", "ambient");
    store.addFact("party planning notes", [u], null);
    const hits = store.search(null, "party", { layer: "both" });
    expect(hits.filter((h) => h.text === "party planning notes")).toHaveLength(1);
    expect(hits[0]!.layer).toBe("fact");
  });

  it("LIKE search treats a bare % in the query as a literal character, not 'match everything'", () => {
    store.addUtterance("100% sure", "ambient");
    store.addUtterance("other text", "ambient");
    const hits = store.search(null, "%");
    expect(hits.map((h) => h.text)).toEqual(["100% sure"]);
  });

  it("LIKE search treats _ in the query as a literal underscore, not 'match any char'", () => {
    store.addUtterance("cat is here", "ambient");
    store.addUtterance("c_t literal here", "ambient");
    const hits = store.search(null, "c_t");
    expect(hits.map((h) => h.text)).toEqual(["c_t literal here"]);
  });

  it("forget treats a bare % in the query as a literal character, not 'delete everything'", () => {
    store.addUtterance("100% sure", "ambient");
    store.addUtterance("other text", "ambient");
    // "100%" (not a bare "%") so the query clears the new min-length guard while
    // still exercising literal-% escaping.
    const result = store.forget("100%");
    expect(result.deleted).toBe(1);
    expect(result.texts).toEqual(["100% sure"]);
    expect(store.search(null, "other").map((h) => h.text)).toEqual(["other text"]);
  });

  it("forget deletes matching rows and reports them", () => {
    store.addUtterance("secret thing happened", "ambient");
    const result = store.forget("secret thing");
    expect(result.deleted).toBe(1);
    expect(result.texts[0]).toContain("secret");
    expect(store.search(null, "secret")).toEqual([]);
  });

  it("forget deletes matches across utterances and facts", () => {
    const u = store.addUtterance("classified info here", "ambient");
    store.addFact("classified info here", [u], null);
    const result = store.forget("classified info");
    expect(result.deleted).toBe(2);
    expect(result.texts.sort()).toEqual(["classified info here", "classified info here"]);
  });

  it("forget refuses a degenerate short (<3 char) query and touches nothing", () => {
    store.addUtterance("we talked about a lot of stuff", "ambient");
    store.addUtterance("of course, everyone agreed", "ambient");
    const result = store.forget("of");
    expect(result).toEqual({ deleted: 0, texts: [] });
    expect(store.search(null, "of")).toHaveLength(2);
  });

  it("forget trims whitespace before the length guard", () => {
    const result = store.forget("  e  ");
    expect(result).toEqual({ deleted: 0, texts: [] });
  });

  it("forget caps deletions at 50 rows, deleting only the most recent matches", () => {
    for (let i = 0; i < 60; i += 1) {
      store.addUtterance(`match number ${i}`, "ambient", 1000 + i);
    }
    const result = store.forget("match number");
    expect(result.deleted).toBe(50);
    expect(result.texts).toHaveLength(50);
    // The 10 oldest matches must survive the cap.
    const remaining = store.search(null, "match number", { topK: 100 });
    expect(remaining).toHaveLength(10);
    const remainingTexts = remaining.map((h) => h.text).sort();
    const expectedSurvivors = Array.from({ length: 10 }, (_, i) => `match number ${i}`).sort();
    expect(remainingTexts).toEqual(expectedSurvivors);
  });

  it("hasFact reports exact-text fact existence", () => {
    const u = store.addUtterance("x", "ambient");
    expect(store.hasFact("milk is out")).toBe(false);
    store.addFact("milk is out", [u], null);
    expect(store.hasFact("milk is out")).toBe(true);
    // Exact match only — not substring / LIKE semantics.
    expect(store.hasFact("milk")).toBe(false);
    expect(store.hasFact("milk is out!")).toBe(false);
  });

  it("suggestion log round-trips", () => {
    const id = store.addSuggestion("reminder", "Create reminder?", { title: "x" });
    store.setSuggestionStatus(id, "dismissed");
    expect(store.recentSuggestions(0).map((s) => s.id)).toEqual([id]);
  });

  it("recentSuggestions respects sinceTs", () => {
    const id1 = store.addSuggestion("reminder", "old", {});
    waitForNextMs();
    const cutoff = Date.now();
    waitForNextMs();
    const id2 = store.addSuggestion("reminder", "new", {});
    expect(store.recentSuggestions(cutoff).map((s) => s.id)).toEqual([id2]);
    expect(store.recentSuggestions(0).map((s) => s.id).sort((a, b) => a - b)).toEqual(
      [id1, id2].sort((a, b) => a - b),
    );
  });

  it("meta round-trips", () => {
    expect(store.getMeta("lastDigest")).toBeNull();
    store.setMeta("lastDigest", "123");
    expect(store.getMeta("lastDigest")).toBe("123");
  });

  it("setMeta overwrites an existing key", () => {
    store.setMeta("k", "v1");
    store.setMeta("k", "v2");
    expect(store.getMeta("k")).toBe("v2");
  });

  it("utterancesBetween returns rows within [t0, t1] inclusive", () => {
    store.addUtterance("a", "ambient", 1000);
    store.addUtterance("b", "ambient", 2000);
    store.addUtterance("c", "ambient", 3000);
    const rows = store.utterancesBetween(1000, 2000);
    expect(rows.map((r) => r.text)).toEqual(["a", "b"]);
  });

  it("close does not throw", () => {
    const s = new MemoryStore(":memory:");
    expect(() => s.close()).not.toThrow();
  });
});

function unitVector(hotIndex: number): Float32Array {
  const v = new Float32Array(768);
  v[hotIndex] = 1;
  return v;
}

// Date.now() has ms granularity; two synchronous statements can land in the
// same ms. Busy-wait for the clock to tick so sinceTs assertions are stable.
function waitForNextMs(): void {
  const start = Date.now();
  while (Date.now() === start) {
    /* spin */
  }
}
