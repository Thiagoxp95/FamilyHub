// apps/electron/src/main/ambient/ollama.test.ts
import { describe, expect, it, vi } from "vitest";
import { createOllamaClient } from "./ollama";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe("createOllamaClient", () => {
  describe("embed", () => {
    it("returns a 768-dim Float32Array on the happy path", async () => {
      const embeddings = Array.from({ length: 768 }, (_, i) => i / 1000);
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ embeddings: [embeddings] }));
      const client = createOllamaClient({ fetchFn });

      const result = await client.embed("hello world");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result!.length).toBe(768);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toBe("http://127.0.0.1:11434/api/embed");
      expect(init.method).toBe("POST");
      const parsedBody = JSON.parse(init.body);
      expect(parsedBody).toEqual({ model: "nomic-embed-text", input: "hello world" });
    });

    it("returns null when the returned vector has the wrong dimension", async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ embeddings: [[1, 2, 3]] }));
      const client = createOllamaClient({ fetchFn });

      const result = await client.embed("hello world");

      expect(result).toBeNull();
    });

    it("returns null on network error", async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const client = createOllamaClient({ fetchFn });

      const result = await client.embed("hello world");

      expect(result).toBeNull();
    });

    it("returns null when embeddings array is empty", async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ embeddings: [] }));
      const client = createOllamaClient({ fetchFn });

      const result = await client.embed("hello world");

      expect(result).toBeNull();
    });

    it("returns null on a non-ok HTTP response", async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false));
      const client = createOllamaClient({ fetchFn });

      const result = await client.embed("hello world");

      expect(result).toBeNull();
    });

    it("resolves null instead of hanging forever when fetch never resolves", async () => {
      vi.useFakeTimers();
      try {
        const fetchFn = vi.fn().mockImplementation(
          (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            }),
        );
        const client = createOllamaClient({ fetchFn });

        const pending = client.embed("hello world");
        await vi.advanceTimersByTimeAsync(15_000);
        const result = await pending;

        expect(result).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("chatJSON", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } };

    it("parses message.content JSON on the happy path", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({ message: { content: '{"answer":"42"}' } }),
      );
      const client = createOllamaClient({ fetchFn });

      const result = await client.chatJSON("system prompt", "user prompt", schema);

      expect(result).toEqual({ answer: "42" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toBe("http://127.0.0.1:11434/api/chat");
      expect(init.method).toBe("POST");
      const parsedBody = JSON.parse(init.body);
      expect(parsedBody).toEqual({
        model: "qwen3:4b",
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "user prompt" },
        ],
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0 },
      });
    });

    it("returns null when message.content is malformed JSON", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({ message: { content: "not json" } }),
      );
      const client = createOllamaClient({ fetchFn });

      const result = await client.chatJSON("system prompt", "user prompt", schema);

      expect(result).toBeNull();
    });

    it("returns null on network error", async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const client = createOllamaClient({ fetchFn });

      const result = await client.chatJSON("system prompt", "user prompt", schema);

      expect(result).toBeNull();
    });

    it("returns null on a non-ok HTTP response", async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false));
      const client = createOllamaClient({ fetchFn });

      const result = await client.chatJSON("system prompt", "user prompt", schema);

      expect(result).toBeNull();
    });
  });

  it("exposes the configured embedModel", () => {
    const client = createOllamaClient({ embedModel: "custom-embed" });
    expect(client.embedModel).toBe("custom-embed");
  });

  it("uses a custom baseUrl when provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ embeddings: [Array(768).fill(0)] }));
    const client = createOllamaClient({ baseUrl: "http://example.local:9999", fetchFn });

    await client.embed("hi");

    const [url] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://example.local:9999/api/embed");
  });
});
