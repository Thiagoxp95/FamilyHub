// apps/electron/src/main/ambient/memoryStore.ts
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

export type UtteranceSource = "ambient" | "session_user" | "session_james";

export interface StoredUtterance {
  id: number;
  ts: number;
  text: string;
  source: UtteranceSource;
  speaker: string | null;
}

export interface MemoryHit {
  id: number;
  ts: number;
  text: string;
  source: string;
  layer: "raw" | "fact";
  score: number;
}

export interface SearchOptions {
  topK?: number;
  layer?: "raw" | "fact" | "both";
  sinceTs?: number;
}

type PendingEmbedding = { table: "utterances" | "facts"; id: number; text: string };

const EMBED_DIM = 768;

function toVecBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

// node:sqlite returns INTEGER columns as bigint only when the value exceeds
// Number.MAX_SAFE_INTEGER; ids/timestamps here never do, but some driver
// paths (e.g. explicit bigint bind params) round-trip as bigint regardless.
// Normalize defensively everywhere an id/ts crosses the boundary.
function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  readonly vectorSearchAvailable: boolean;

  constructor(dbPath: string) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    this.db = db;

    if (dbPath !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS utterances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        speaker TEXT,
        embed_model TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_utterances_ts ON utterances(ts);
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_utterance_ids TEXT NOT NULL,
        expires_at INTEGER,
        embed_model TEXT
      );
      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'shown'
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);

    let vectorSearchAvailable = false;
    try {
      db.loadExtension(sqliteVec.getLoadablePath());
      // distance_metric=cosine: sqlite-vec's default metric is L2, which is
      // magnitude-sensitive. Text embeddings are compared by direction, and
      // `score = 1 - distance/2` below assumes cosine distance's [0,2] range
      // (0 = identical direction, 1 = orthogonal, 2 = opposite).
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_utterances USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine);
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine);
      `);
      vectorSearchAvailable = true;
    } catch {
      vectorSearchAvailable = false;
    }
    this.vectorSearchAvailable = vectorSearchAvailable;
  }

  addUtterance(text: string, source: UtteranceSource, ts: number = Date.now()): number {
    const result = this.db
      .prepare("INSERT INTO utterances (ts, text, source) VALUES (?, ?, ?)")
      .run(ts, text, source);
    return toNumber(result.lastInsertRowid);
  }

  addFact(text: string, sourceIds: number[], expiresAt: number | null): number {
    const result = this.db
      .prepare(
        "INSERT INTO facts (ts, text, source_utterance_ids, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(Date.now(), text, JSON.stringify(sourceIds), expiresAt);
    return toNumber(result.lastInsertRowid);
  }

  recentWindow(maxWords: number): StoredUtterance[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, text, source, speaker FROM utterances
         WHERE source IN ('ambient', 'session_user', 'session_james')
         ORDER BY ts DESC LIMIT 200`,
      )
      .all() as Array<{
      id: number | bigint;
      ts: number | bigint;
      text: string;
      source: string;
      speaker: string | null;
    }>;

    const picked: StoredUtterance[] = [];
    let wordCount = 0;
    for (const row of rows) {
      const words = row.text.trim().split(/\s+/).filter(Boolean).length;
      if (picked.length > 0 && wordCount + words > maxWords) break;
      picked.push({
        id: toNumber(row.id),
        ts: toNumber(row.ts),
        text: row.text,
        source: row.source as UtteranceSource,
        speaker: row.speaker,
      });
      wordCount += words;
      if (wordCount >= maxWords) break;
    }
    return picked.reverse();
  }

  pendingEmbeddings(limit: number): PendingEmbedding[] {
    if (!this.vectorSearchAvailable) return [];

    const results: PendingEmbedding[] = [];
    const utteranceRows = this.db
      .prepare(
        "SELECT id, text FROM utterances WHERE embed_model IS NULL ORDER BY ts ASC LIMIT ?",
      )
      .all(limit) as Array<{ id: number | bigint; text: string }>;
    for (const row of utteranceRows) {
      results.push({ table: "utterances", id: toNumber(row.id), text: row.text });
    }

    if (results.length < limit) {
      const factRows = this.db
        .prepare(
          "SELECT id, text FROM facts WHERE embed_model IS NULL ORDER BY ts ASC LIMIT ?",
        )
        .all(limit - results.length) as Array<{ id: number | bigint; text: string }>;
      for (const row of factRows) {
        results.push({ table: "facts", id: toNumber(row.id), text: row.text });
      }
    }

    return results.slice(0, limit);
  }

  setEmbedding(table: "utterances" | "facts", id: number, vector: Float32Array, model: string): void {
    if (!this.vectorSearchAvailable) return;
    const vecTable = table === "utterances" ? "vec_utterances" : "vec_facts";
    this.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`).run(id);
    // vec0 virtual tables reject plain-number rowids on INSERT ("Only
    // integers are allowed for primary key values") — must bind as bigint.
    this.db
      .prepare(`INSERT INTO ${vecTable} (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(id), toVecBytes(vector));
    this.db.prepare(`UPDATE ${table} SET embed_model = ? WHERE id = ?`).run(model, id);
  }

  private searchRaw(queryVector: Float32Array | null, queryText: string, topK: number, sinceTs: number | undefined): MemoryHit[] {
    if (queryVector && this.vectorSearchAvailable) {
      const rows = this.db
        .prepare(
          `SELECT v.rowid AS id, v.distance AS distance, u.ts AS ts, u.text AS text, u.source AS source
           FROM vec_utterances v
           JOIN utterances u ON u.id = v.rowid
           WHERE v.embedding MATCH ? AND k = ?
           ${sinceTs !== undefined ? "AND u.ts >= ?" : ""}
           ORDER BY v.distance`,
        )
        .all(
          ...(sinceTs !== undefined
            ? [toVecBytes(queryVector), topK, sinceTs]
            : [toVecBytes(queryVector), topK]),
        ) as Array<{ id: number | bigint; distance: number; ts: number | bigint; text: string; source: string }>;
      return rows.map((row) => ({
        id: toNumber(row.id),
        ts: toNumber(row.ts),
        text: row.text,
        source: row.source,
        layer: "raw" as const,
        score: 1 - row.distance / 2,
      }));
    }

    const params: Array<string | number> = [`%${queryText}%`];
    let sql = "SELECT id, ts, text, source FROM utterances WHERE text LIKE ?";
    if (sinceTs !== undefined) {
      sql += " AND ts >= ?";
      params.push(sinceTs);
    }
    sql += " ORDER BY ts DESC LIMIT ?";
    params.push(topK);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number | bigint;
      ts: number | bigint;
      text: string;
      source: string;
    }>;
    return rows.map((row) => ({
      id: toNumber(row.id),
      ts: toNumber(row.ts),
      text: row.text,
      source: row.source,
      layer: "raw" as const,
      score: 0.5,
    }));
  }

  private searchFacts(queryVector: Float32Array | null, queryText: string, topK: number, sinceTs: number | undefined): MemoryHit[] {
    const now = Date.now();
    if (queryVector && this.vectorSearchAvailable) {
      const rows = this.db
        .prepare(
          `SELECT v.rowid AS id, v.distance AS distance, f.ts AS ts, f.text AS text
           FROM vec_facts v
           JOIN facts f ON f.id = v.rowid
           WHERE v.embedding MATCH ? AND k = ?
           AND (f.expires_at IS NULL OR f.expires_at >= ?)
           ${sinceTs !== undefined ? "AND f.ts >= ?" : ""}
           ORDER BY v.distance`,
        )
        .all(
          ...(sinceTs !== undefined
            ? [toVecBytes(queryVector), topK, now, sinceTs]
            : [toVecBytes(queryVector), topK, now]),
        ) as Array<{ id: number | bigint; distance: number; ts: number | bigint; text: string }>;
      return rows.map((row) => ({
        id: toNumber(row.id),
        ts: toNumber(row.ts),
        text: row.text,
        source: "fact",
        layer: "fact" as const,
        score: 1 - row.distance / 2,
      }));
    }

    const params: Array<string | number> = [now, `%${queryText}%`];
    let sql = `SELECT id, ts, text FROM facts
      WHERE (expires_at IS NULL OR expires_at >= ?) AND text LIKE ?`;
    if (sinceTs !== undefined) {
      sql += " AND ts >= ?";
      params.push(sinceTs);
    }
    sql += " ORDER BY ts DESC LIMIT ?";
    params.push(topK);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number | bigint;
      ts: number | bigint;
      text: string;
    }>;
    return rows.map((row) => ({
      id: toNumber(row.id),
      ts: toNumber(row.ts),
      text: row.text,
      source: "fact",
      layer: "fact" as const,
      score: 0.5,
    }));
  }

  search(queryVector: Float32Array | null, queryText: string, opts: SearchOptions = {}): MemoryHit[] {
    const topK = opts.topK ?? 5;
    const layer = opts.layer ?? "raw";
    const sinceTs = opts.sinceTs;

    if (layer === "raw") return this.searchRaw(queryVector, queryText, topK, sinceTs);
    if (layer === "fact") return this.searchFacts(queryVector, queryText, topK, sinceTs);

    const factHits = this.searchFacts(queryVector, queryText, topK, sinceTs);
    const rawHits = this.searchRaw(queryVector, queryText, topK, sinceTs);
    const seen = new Set(factHits.map((h) => h.text));
    const dedupedRaw = rawHits.filter((h) => !seen.has(h.text));
    return [...factHits, ...dedupedRaw];
  }

  forget(matchText: string): { deleted: number; texts: string[] } {
    const like = `%${matchText}%`;
    const texts: string[] = [];

    const utteranceRows = this.db
      .prepare("SELECT id, text FROM utterances WHERE text LIKE ?")
      .all(like) as Array<{ id: number | bigint; text: string }>;
    for (const row of utteranceRows) {
      texts.push(row.text);
      const id = toNumber(row.id);
      if (this.vectorSearchAvailable) {
        this.db.prepare("DELETE FROM vec_utterances WHERE rowid = ?").run(id);
      }
      this.db.prepare("DELETE FROM utterances WHERE id = ?").run(id);
    }

    const factRows = this.db
      .prepare("SELECT id, text FROM facts WHERE text LIKE ?")
      .all(like) as Array<{ id: number | bigint; text: string }>;
    for (const row of factRows) {
      texts.push(row.text);
      const id = toNumber(row.id);
      if (this.vectorSearchAvailable) {
        this.db.prepare("DELETE FROM vec_facts WHERE rowid = ?").run(id);
      }
      this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    }

    return { deleted: texts.length, texts };
  }

  addSuggestion(kind: string, text: string, payload: Record<string, unknown>): number {
    const result = this.db
      .prepare("INSERT INTO suggestions (ts, kind, text, payload) VALUES (?, ?, ?, ?)")
      .run(Date.now(), kind, text, JSON.stringify(payload));
    return toNumber(result.lastInsertRowid);
  }

  setSuggestionStatus(id: number, status: "accepted" | "dismissed" | "expired"): void {
    this.db.prepare("UPDATE suggestions SET status = ? WHERE id = ?").run(status, id);
  }

  recentSuggestions(sinceTs: number): Array<{ id: number; ts: number; text: string }> {
    const rows = this.db
      .prepare("SELECT id, ts, text FROM suggestions WHERE ts >= ? ORDER BY ts ASC")
      .all(sinceTs) as Array<{ id: number | bigint; ts: number | bigint; text: string }>;
    return rows.map((row) => ({ id: toNumber(row.id), ts: toNumber(row.ts), text: row.text }));
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  utterancesBetween(t0: number, t1: number): StoredUtterance[] {
    const rows = this.db
      .prepare(
        "SELECT id, ts, text, source, speaker FROM utterances WHERE ts >= ? AND ts <= ? ORDER BY ts ASC",
      )
      .all(t0, t1) as Array<{
      id: number | bigint;
      ts: number | bigint;
      text: string;
      source: string;
      speaker: string | null;
    }>;
    return rows.map((row) => ({
      id: toNumber(row.id),
      ts: toNumber(row.ts),
      text: row.text,
      source: row.source as UtteranceSource,
      speaker: row.speaker,
    }));
  }

  close(): void {
    this.db.close();
  }
}
