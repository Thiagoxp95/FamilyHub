#!/usr/bin/env node
// apps/electron/scripts/trigger-bench.mjs
//
// Trigger-quality bench: replays a labeled corpus of kitchen-transcript
// windows against a live Ollama server using the EXACT system prompt and
// JSON schema the real TriggerEngine sends, and reports precision/recall
// against the labels.
//
// This is a *copy* of the prompt/schema from
// src/main/ambient/triggerEngine.ts, not an import — the engine module
// pulls in Electron-only deps (better-sqlite3-style native bindings via
// MemoryStore) that don't load under plain Node. Keep the two in sync by
// hand; triggerEngine.ts has a comment pointing back here.
//
// Usage:
//   ollama serve                      # in another terminal
//   ollama pull qwen3:4b
//   ollama pull nomic-embed-text
//   node scripts/trigger-bench.mjs
//
// Env overrides (match the app's env vars):
//   FAMILYHUB_OLLAMA_URL   default http://127.0.0.1:11434
//   FAMILYHUB_AMBIENT_LLM  default qwen3:4b

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(__dirname, "trigger-corpus.jsonl");

const BASE_URL = process.env.FAMILYHUB_OLLAMA_URL ?? "http://127.0.0.1:11434";
const CHAT_MODEL = process.env.FAMILYHUB_AMBIENT_LLM ?? "qwen3:4b";
const CONFIDENCE_THRESHOLD = 0.7;
const CHAT_TIMEOUT_MS = 60_000;
const MAX_CONCURRENCY = 4;

// ---------------------------------------------------------------------
// SYNC BLOCK: keep byte-for-byte in step with
// src/main/ambient/triggerEngine.ts (SYSTEM_PROMPT_PREFIX,
// SYSTEM_PROMPT_SUFFIX, TRIGGER_SCHEMA). If you edit the prompt there to
// fix a bench failure, paste the same edit here before re-running.
// ---------------------------------------------------------------------
const TRIGGER_SCHEMA = {
  type: "object",
  properties: {
    trigger: { type: "boolean" },
    kind: { enum: ["reminder", "calendar", "question", "shopping", "other"] },
    confidence: { type: "number" },
    suggestion: { type: "string" },
    payload: { type: "object" },
  },
  required: ["trigger", "kind", "confidence", "suggestion", "payload"],
};

const SYSTEM_PROMPT_PREFIX =
  "You watch a rolling transcript of a family's kitchen conversation. Decide " +
  "whether the voice assistant (James) could usefully offer help RIGHT NOW, " +
  "focusing on the most recent topic and using the rest as context. Today is ";

const SYSTEM_PROMPT_SUFFIX = `. The family mixes English and Portuguese; treat both the same.

Set trigger true (confidence 0.8 or higher) when the transcript contains ANY of:
1. A FUTURE commitment, appointment, or deadline: a party, doctor/dentist visit, school pickup, meeting, haircut, or bill due date (kind "reminder" or "calendar"; payload {"title", "due" ISO local}). Capturing it as a reminder helps even when the speakers sound organized, and even when the last line is just someone acknowledging it.
2. A factual question asked aloud (distance, weather, unit conversion, general facts, travel time) that nobody answered CONFIDENTLY (kind "question"; payload {"question"}). "I think...", "not sure", "maybe", "depends" are guesses, not answers — still trigger.
3. A household item that is out, almost out, or running low, or an explicit ask to buy something or add it to a list (kind "shopping"; payload {"item"}). Using up the last of something counts — that means it needs restocking.

Set trigger false ONLY for:
- Chit-chat, opinions, feelings, or emotional support.
- TV/radio/media audio in the background, or kids playing pretend.
- Recipe or instruction steps being read aloud.
- Strictly PAST or already-handled things: events that already happened, bills already paid, questions already answered confidently in the transcript.

Examples:
"We're almost out of ketchup." -> {"trigger": true, "kind": "shopping", "confidence": 0.9, "suggestion": "Add ketchup to the shopping list?", "payload": {"item": "ketchup"}}
"Liam's soccer game is Friday at 5pm." -> {"trigger": true, "kind": "reminder", "confidence": 0.9, "suggestion": "Create a reminder: Liam's soccer game, Friday 5pm?", "payload": {"title": "Liam's soccer game", "due": "2026-07-17T17:00:00"}}
"How tall is the Eiffel Tower?" / "Maybe three hundred meters?" -> {"trigger": true, "kind": "question", "confidence": 0.85, "suggestion": "Want me to look up how tall the Eiffel Tower is?", "payload": {"question": "How tall is the Eiffel Tower?"}}
"I'm exhausted after that workout." / "You earned a rest." -> {"trigger": false, "kind": "other", "confidence": 0.9, "suggestion": "", "payload": {}}
"Did you book the car service?" / "Yes, I did it this morning." -> {"trigger": false, "kind": "other", "confidence": 0.9, "suggestion": "", "payload": {}}

If the transcript matches one of the three trigger categories, prefer trigger true. suggestion is one short sentence.`;
// ---------------------------------------------------------------------
// END SYNC BLOCK
// ---------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Same local wall-clock semantics as triggerEngine.ts's localIsoDateTime:
// anchor "today" in the machine's local timezone, not UTC.
function localIsoDateTime(now) {
  const d = new Date(now);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function buildSystemPrompt(now) {
  return `${SYSTEM_PROMPT_PREFIX}${localIsoDateTime(now)}${SYSTEM_PROMPT_SUFFIX}`;
}

async function chatJSON(system, user) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        think: false,
        format: TRIGGER_SCHEMA,
        options: { temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    const content = body?.message?.content;
    if (typeof content !== "string") {
      throw new Error("missing message.content in Ollama response");
    }
    return JSON.parse(content);
  } finally {
    clearTimeout(timeout);
  }
}

function parseCorpus(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        throw new Error(`corpus line ${i + 1}: invalid JSON (${err.message})`);
      }
      if (typeof obj.window !== "string" || typeof obj.expect !== "boolean") {
        throw new Error(`corpus line ${i + 1}: missing required "window"/"expect" fields`);
      }
      return obj;
    });
}

// Simple bounded-concurrency pool: run `items` through `worker`, at most
// `limit` in flight at once, preserving input order in the result array.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

// Mirrors triggerEngine.ts's parseTriggerResult: a response production
// would drop (bad kind, NaN confidence, non-string suggestion, non-object
// payload) must not count as a trigger here either.
const TRIGGER_KINDS = new Set(["reminder", "calendar", "question", "shopping", "other"]);

function isValidTriggerResult(raw) {
  if (typeof raw !== "object" || raw === null) return false;
  if (typeof raw.trigger !== "boolean") return false;
  if (typeof raw.kind !== "string" || !TRIGGER_KINDS.has(raw.kind)) return false;
  if (typeof raw.confidence !== "number" || Number.isNaN(raw.confidence)) return false;
  if (typeof raw.suggestion !== "string") return false;
  if (typeof raw.payload !== "object" || raw.payload === null || Array.isArray(raw.payload)) {
    return false;
  }
  return true;
}

async function classify(caseEntry, now) {
  const system = buildSystemPrompt(now);
  try {
    const raw = await chatJSON(system, caseEntry.window);
    const trigger =
      isValidTriggerResult(raw) && raw.trigger && raw.confidence >= CONFIDENCE_THRESHOLD;
    return { ok: true, trigger, raw };
  } catch (err) {
    return { ok: false, trigger: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const corpusText = readFileSync(CORPUS_PATH, "utf8");
  const cases = parseCorpus(corpusText);
  const now = Date.now();

  console.log(
    `Trigger-quality bench: ${cases.length} windows, model=${CHAT_MODEL}, url=${BASE_URL}`,
  );
  console.log(`(this takes a few minutes; up to ${MAX_CONCURRENCY} requests in flight)\n`);

  let done = 0;
  const results = await runPool(cases, MAX_CONCURRENCY, async (c) => {
    const result = await classify(c, now);
    done += 1;
    const label = c.expect ? "POS" : "NEG";
    let verdict;
    if (!result.ok) {
      verdict = "ERROR";
    } else if (result.trigger === c.expect) {
      verdict = "PASS";
    } else {
      verdict = "FAIL";
    }
    const suffix = result.ok ? "" : ` (${result.error})`;
    console.log(
      `[${done}/${cases.length}] ${verdict} ${label} expect=${c.expect} got=${result.trigger}` +
        ` kind=${c.kind ?? "-"} :: ${c.note}${suffix}`,
    );
    return result;
  });

  let truePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let errors = 0;

  cases.forEach((c, i) => {
    const r = results[i];
    if (!r.ok) {
      errors += 1;
      return;
    }
    if (c.expect && r.trigger) truePositives += 1;
    else if (c.expect && !r.trigger) falseNegatives += 1;
    else if (!c.expect && !r.trigger) trueNegatives += 1;
    else if (!c.expect && r.trigger) falsePositives += 1;
  });

  const positiveCount = cases.filter((c) => c.expect).length;
  const negativeCount = cases.filter((c) => !c.expect).length;
  const recall = positiveCount > 0 ? truePositives / positiveCount : 1;
  const precision =
    truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 1;

  console.log("\n--- Summary ---");
  console.log(`positives: ${positiveCount} (TP=${truePositives} FN=${falseNegatives})`);
  console.log(`negatives: ${negativeCount} (TN=${trueNegatives} FP=${falsePositives})`);
  if (errors > 0) console.log(`errors (excluded from scoring): ${errors}`);
  console.log(`recall:    ${recall.toFixed(3)}`);
  console.log(`precision: ${precision.toFixed(3)}`);
  console.log(`false triggers on negatives: ${falsePositives} / ${negativeCount}`);

  const recallOk = recall >= 0.8;
  const falseTriggerOk = falsePositives <= 2;
  if (!recallOk) {
    console.error(`\nFAIL: recall ${recall.toFixed(3)} is below the 0.8 threshold`);
  }
  if (!falseTriggerOk) {
    console.error(`\nFAIL: ${falsePositives} false triggers exceeds the 2-false-trigger threshold`);
  }
  if (!recallOk || !falseTriggerOk) {
    process.exit(1);
  }
  console.log("\nPASS: thresholds met.");
}

main().catch((err) => {
  console.error("bench crashed:", err);
  process.exit(1);
});
