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
  private running = false;

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

  /**
   * Processes up to BATCH_SIZE pending rows. Never rejects: store calls
   * (synchronous node:sqlite, can throw on busy DB / disk errors) and embed
   * calls are all guarded, matching the feature's never-throw bar — a
   * rejection here would be unhandled forever via the interval's `void`.
   * Overlap-guarded: if a previous tick is still in flight (embed has no
   * timeout), this resolves 0 immediately instead of re-fetching the same
   * pending rows.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let embedded = 0;
    try {
      const pending = this.store.pendingEmbeddings(BATCH_SIZE);
      for (const row of pending) {
        let vector: Float32Array | null;
        try {
          vector = await this.ollama.embed(row.text);
        } catch {
          vector = null;
        }
        if (!vector) continue;
        try {
          this.store.setEmbedding(row.table, row.id, vector, this.ollama.embedModel);
          embedded += 1;
        } catch {
          // Row stays pending; retried on a later tick.
        }
      }
    } catch {
      // pendingEmbeddings failed; nothing to do this tick.
    } finally {
      this.running = false;
    }
    return embedded;
  }
}
