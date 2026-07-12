// apps/electron/src/main/ambient/factsDigest.ts
//
// Nightly digest: distills the last day of raw utterances into durable
// "facts" (events, plans, preferences, decisions, names) via a local LLM
// call, storing them in the curated `facts` layer of MemoryStore.
import type { MemoryStore, StoredUtterance } from "./memoryStore";
import type { OllamaClient } from "./ollama";

const LAST_DIGEST_META_KEY = "lastDigestTs";
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const CATCHUP_THRESHOLD_MS = 26 * 60 * 60 * 1000;
const SCHEDULE_INTERVAL_MS = 30 * 60 * 1000;
const MAX_CHUNK_WORDS = 4000;
const EXPIRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST_HOUR = 3;
const DIGEST_MINUTE = 30;

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          expiresAt: {
            type: ["string", "null"],
            description: "ISO date after which stale, or null",
          },
        },
        required: ["text", "expiresAt"],
      },
    },
  },
  required: ["facts"],
};

const SYSTEM_PROMPT_PREFIX =
  "You distill a day of household kitchen conversation into durable facts " +
  "worth remembering (events with dates, plans, preferences, decisions, " +
  "names). Resolve relative dates using the provided current date. Ignore " +
  "chit-chat. Today is ";

interface DigestFact {
  text: string;
  expiresAt: string | null;
}

function chunkByWords(utterances: StoredUtterance[], maxWords: number): StoredUtterance[][] {
  const chunks: StoredUtterance[][] = [];
  let current: StoredUtterance[] = [];
  let wordCount = 0;
  for (const utterance of utterances) {
    const words = utterance.text.trim().split(/\s+/).filter(Boolean).length;
    if (current.length > 0 && wordCount + words > maxWords) {
      chunks.push(current);
      current = [];
      wordCount = 0;
    }
    current.push(utterance);
    wordCount += words;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// The model's response is untrusted (network hop + JSON parse already
// happened in ollama.ts). Validate the shape fully before trusting any of
// it — a malformed-but-non-null response must be treated the same as a
// failed chunk, not crash or silently store garbage.
function parseFacts(raw: unknown): DigestFact[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const facts = (raw as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return null;

  const result: DigestFact[] = [];
  for (const item of facts) {
    if (typeof item !== "object" || item === null) return null;
    const text = (item as { text?: unknown }).text;
    const expiresAt = (item as { expiresAt?: unknown }).expiresAt;
    if (typeof text !== "string") return null;
    if (expiresAt !== null && typeof expiresAt !== "string") return null;
    result.push({ text, expiresAt });
  }
  return result;
}

function resolveExpiresAtMs(expiresAt: string | null): number | null {
  if (expiresAt === null) return null;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return null;
  return parsed + EXPIRY_GRACE_MS;
}

function buildUserPrompt(chunk: StoredUtterance[]): string {
  return chunk.map((u) => u.text).join("\n");
}

// LOCAL calendar date (same local-time semantics as shouldRunDigest).
// toISOString() would anchor in UTC: at the 03:30 local trigger in any
// positive-offset timezone that reports YESTERDAY's date, so the model
// would misresolve every relative date ("tomorrow", "next tuesday", ...).
function localIsoDate(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Reads utterances since `meta.lastDigestTs` (default: 24h before `now`),
 * chunks them into ≤4000-word batches, and asks the local LLM to distill
 * each chunk into durable facts. `meta.lastDigestTs` only advances to `now`
 * if every chunk succeeded — a failed chunk (null/malformed chatJSON
 * response) means those utterances would be permanently skipped if we
 * advanced past them, so we leave the watermark behind to retry next run.
 */
export async function runDigest(
  store: MemoryStore,
  ollama: OllamaClient,
  now: number = Date.now(),
): Promise<number> {
  const lastTsRaw = store.getMeta(LAST_DIGEST_META_KEY);
  const t0 = lastTsRaw !== null ? Number(lastTsRaw) : now - DEFAULT_LOOKBACK_MS;
  const utterances = store.utterancesBetween(t0, now);
  const chunks = chunkByWords(utterances, MAX_CHUNK_WORDS);

  const system = `${SYSTEM_PROMPT_PREFIX}${localIsoDate(now)}.`;

  let factsAdded = 0;
  let anyChunkFailed = false;

  for (const chunk of chunks) {
    const raw = await ollama.chatJSON(system, buildUserPrompt(chunk), FACTS_SCHEMA);
    const facts = parseFacts(raw);
    if (facts === null) {
      anyChunkFailed = true;
      continue;
    }
    for (const fact of facts) {
      // A partial failure keeps lastDigestTs behind, so the retry reprocesses
      // chunks that already succeeded — skip facts whose exact text is
      // already stored instead of duplicating them.
      if (store.hasFact(fact.text)) continue;
      store.addFact(fact.text, [], resolveExpiresAtMs(fact.expiresAt));
      factsAdded += 1;
    }
  }

  if (!anyChunkFailed) {
    store.setMeta(LAST_DIGEST_META_KEY, String(now));
  }

  return factsAdded;
}

/**
 * True iff `now` (local time) is past today's 03:30 AND the digest hasn't
 * already run since today's 03:30 (i.e. `lastTs` is null or predates it).
 */
export function shouldRunDigest(lastTs: number | null, now: number): boolean {
  const nowDate = new Date(now);
  const todayThreshold = new Date(nowDate);
  todayThreshold.setHours(DIGEST_HOUR, DIGEST_MINUTE, 0, 0);

  if (nowDate.getTime() < todayThreshold.getTime()) return false;
  if (lastTs === null) return true;
  return lastTs < todayThreshold.getTime();
}

function readLastDigestTs(store: MemoryStore): number | null {
  const raw = store.getMeta(LAST_DIGEST_META_KEY);
  return raw !== null ? Number(raw) : null;
}

/**
 * Checks every 30 minutes whether the nightly digest is due (past today's
 * 03:30 and not already run today), plus a one-shot catch-up at startup if
 * the digest hasn't run in over 26h (covers the machine being asleep/off at
 * 03:30). Returns a cancel function that stops the interval.
 */
export function scheduleDigest(store: MemoryStore, ollama: OllamaClient): () => void {
  // runDigest does synchronous node:sqlite writes that can throw (disk full,
  // WAL lock, ...). From these background-timer call sites a rejection would
  // be unhandled and crash the main process, so every run is caught here.
  // Log only the first failure (mirroring ipc.ts's storeQuietly precedent)
  // to avoid one line per 30-min tick while the disk stays full.
  let failureLogged = false;
  function runQuietly(now: number): void {
    runDigest(store, ollama, now).catch((error: unknown) => {
      if (failureLogged) return;
      failureLogged = true;
      console.error(
        "[factsDigest] digest run failed (further failures muted):",
        error instanceof Error ? error.message : error,
      );
    });
  }

  const startupNow = Date.now();
  let startupLastTs: number | null = null;
  let startupReadFailed = false;
  try {
    startupLastTs = readLastDigestTs(store);
  } catch {
    // getMeta threw (store unhealthy); skip catch-up rather than crash —
    // the interval below retries the read every 30 min.
    startupReadFailed = true;
  }
  if (
    !startupReadFailed &&
    (startupLastTs === null || startupNow - startupLastTs > CATCHUP_THRESHOLD_MS)
  ) {
    runQuietly(startupNow);
  }

  const timer = setInterval(() => {
    const now = Date.now();
    let lastTs: number | null;
    try {
      lastTs = readLastDigestTs(store);
    } catch {
      return; // store unhealthy this tick; retry next tick.
    }
    if (shouldRunDigest(lastTs, now)) {
      runQuietly(now);
    }
  }, SCHEDULE_INTERVAL_MS);

  return () => {
    clearInterval(timer);
  };
}
