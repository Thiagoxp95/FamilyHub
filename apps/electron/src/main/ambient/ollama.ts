// apps/electron/src/main/ambient/ollama.ts

const EMBED_DIM = 768;
const CHAT_TIMEOUT_MS = 20_000;
const EMBED_TIMEOUT_MS = 15_000;

export interface OllamaClient {
  embed(text: string): Promise<Float32Array | null>; // null on any failure
  chatJSON(system: string, user: string, schema: Record<string, unknown>): Promise<unknown | null>;
  embedModel: string;
}

export interface CreateOllamaClientOptions {
  baseUrl?: string;
  chatModel?: string;
  embedModel?: string;
  fetchFn?: typeof fetch;
}

function defaultBaseUrl(): string {
  return process.env.FAMILYHUB_OLLAMA_URL ?? "http://127.0.0.1:11434";
}

function defaultChatModel(): string {
  return process.env.FAMILYHUB_AMBIENT_LLM ?? "qwen3:4b";
}

function defaultEmbedModel(): string {
  return process.env.FAMILYHUB_AMBIENT_EMBED_MODEL ?? "nomic-embed-text";
}

export function createOllamaClient(options: CreateOllamaClientOptions = {}): OllamaClient {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const chatModel = options.chatModel ?? defaultChatModel();
  const embedModel = options.embedModel ?? defaultEmbedModel();
  const fetchFn = options.fetchFn ?? fetch;

  // Logged only on availability-state transitions to avoid spamming logs
  // when Ollama is down for an extended period.
  let wasAvailable = true;
  function reportAvailability(available: boolean, reason?: unknown): void {
    if (available === wasAvailable) return;
    wasAvailable = available;
    if (available) {
      console.error("[ollama] became available again");
    } else {
      console.error("[ollama] unavailable:", reason instanceof Error ? reason.message : reason);
    }
  }

  async function embed(text: string): Promise<Float32Array | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: embedModel, input: text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        reportAvailability(false, `HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { embeddings?: unknown };
      const vectors = Array.isArray(body.embeddings) ? body.embeddings : [];
      const first = vectors[0];
      if (!Array.isArray(first) || first.length !== EMBED_DIM) {
        reportAvailability(false, "unexpected embedding dimension");
        return null;
      }
      reportAvailability(true);
      return Float32Array.from(first as number[]);
    } catch (err) {
      reportAvailability(false, err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function chatJSON(
    system: string,
    user: string,
    schema: Record<string, unknown>,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: chatModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
          think: false,
          format: schema,
          options: { temperature: 0 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        reportAvailability(false, `HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { message?: { content?: string } };
      const content = body.message?.content;
      if (typeof content !== "string") {
        reportAvailability(false, "missing message.content");
        return null;
      }
      const parsed: unknown = JSON.parse(content);
      reportAvailability(true);
      return parsed;
    } catch (err) {
      reportAvailability(false, err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { embed, chatJSON, embedModel };
}
