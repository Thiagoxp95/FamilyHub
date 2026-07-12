// apps/electron/src/main/ambient/embedWorker.ts
import type { MemoryStore } from "./memoryStore";
import type { OllamaClient } from "./ollama";

const DEFAULT_INTERVAL_MS = 15_000;
const BATCH_SIZE = 16;

export interface EmbedWorkerOptions {
  store: MemoryStore;
  ollama: OllamaClient;
  intervalMs?: number;
}

export class EmbedWorker {
  private readonly store: MemoryStore;
  private readonly ollama: OllamaClient;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EmbedWorkerOptions) {
    this.store = options.store;
    this.ollama = options.ollama;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    const pending = this.store.pendingEmbeddings(BATCH_SIZE);
    let embedded = 0;
    for (const row of pending) {
      let vector: Float32Array | null;
      try {
        vector = await this.ollama.embed(row.text);
      } catch {
        vector = null;
      }
      if (!vector) continue;
      this.store.setEmbedding(row.table, row.id, vector, this.ollama.embedModel);
      embedded += 1;
    }
    return embedded;
  }
}
