/**
 * Stage 3 of the compaction-plus architecture: local spill store with a
 * RAPTOR-lite retrieval index.
 *
 * Each session owns one append-only JSONL file `<spillDir>/<sessionId>.jsonl`.
 * Compacted text is appended with a timestamp and its message role. Retrieval
 * is a deliberately simple inverted index built lazily per file: tokens are
 * lowercase alphanumeric runs and a query is scored by token overlap, so
 * `search` returns the most relevant spilled entries without any embedding
 * model or network call.
 *
 * A per-session byte cap keeps the store bounded: when the file grows past
 * `maxBytes`, the oldest entries are dropped first. Corrupt lines are skipped
 * on read rather than failing the session.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SpillEntry {
  /** Unix epoch milliseconds; entries are stored in append order. */
  ts: number;
  role: string;
  text: string;
}

export interface SpillHit extends SpillEntry {
  /** Token overlap score between the query and the entry text; higher is better. */
  score: number;
}

export const DEFAULT_SPILL_OPTIONS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
});

/** Env override used by tests to redirect the default store into a temp dir. */
const DEFAULT_SPILL_DIR = process.env.DSH_COMPACT_PLUS_SPILL_DIR ?? join(".dsh", "compaction-spill");

/** Keep session ids to a safe filename alphabet; session ids are UUID-shaped in practice. */
function safeFileName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

class SpillIndex {
  /** Token -> 1-based positions (line numbers) of the entries containing it. */
  readonly byToken = new Map<string, number[]>();

  constructor(entries: readonly SpillEntry[]) {
    entries.forEach((entry, position) => {
      for (const token of new Set(tokenize(entry.text))) {
        const positions = this.byToken.get(token);
        if (positions) positions.push(position + 1);
        else this.byToken.set(token, [position + 1]);
      }
    });
  }

  /** Score one entry position by how many distinct query tokens it contains. */
  scoreAt(position: number, queryTokens: readonly string[]): number {
    let score = 0;
    for (const token of queryTokens) {
      const positions = this.byToken.get(token);
      if (positions?.includes(position)) score += 1;
    }
    return score;
  }
}

/**
 * Totally-ordered store accessor. All reads load the session file once and
 * build its index lazily; appends invalidate the cached index. Sync IO is
 * deliberate: compaction runs inside a short event dispatch and a spill must
 * never fail the compaction that triggered it.
 */
export class SpillStore {
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #indexes = new Map<string, SpillIndex>();
  readonly #entries = new Map<string, SpillEntry[]>();

  constructor(dir: string = DEFAULT_SPILL_DIR, maxBytes: number = DEFAULT_SPILL_OPTIONS.maxBytes) {
    this.#dir = dir;
    this.#maxBytes = maxBytes;
  }

  #file(sessionId: string): string {
    return join(this.#dir, `${safeFileName(sessionId)}.jsonl`);
  }

  /** Append entries in order, creating the store directory on first use. */
  append(sessionId: string, entries: readonly SpillEntry[]): void {
    if (entries.length === 0) return;
    mkdirSync(this.#dir, { recursive: true });
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    appendFileSync(this.#file(sessionId), lines, "utf8");
    this.#indexes.delete(sessionId);
    this.#entries.delete(sessionId);
    this.#enforceCap(sessionId);
  }

  /** Read a session's entries, skipping corrupt lines. Never throws. */
  read(sessionId: string): SpillEntry[] {
    const cached = this.#entries.get(sessionId);
    if (cached) return cached;
    let raw: string;
    try {
      raw = readFileSync(this.#file(sessionId), "utf8");
    } catch {
      const empty: SpillEntry[] = [];
      this.#entries.set(sessionId, empty);
      return empty;
    }
    const entries: SpillEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed === "object" && parsed !== null &&
          typeof (parsed as SpillEntry).text === "string" &&
          typeof (parsed as SpillEntry).role === "string" &&
          typeof (parsed as SpillEntry).ts === "number"
        ) {
          entries.push(parsed as SpillEntry);
        }
      } catch {
        // Skip corrupt lines; a store file must never break a session.
      }
    }
    this.#entries.set(sessionId, entries);
    return entries;
  }

  /** Number of spilled entries currently stored for one session. */
  count(sessionId: string): number {
    return this.read(sessionId).length;
  }

  /**
   * Return up to `k` entries with the highest query-token overlap, best first.
   * Ties resolve to the most recently spilled entry.
   */
  search(sessionId: string, query: string, k = 5): SpillHit[] {
    const entries = this.read(sessionId);
    if (entries.length === 0 || k <= 0) return [];
    let index = this.#indexes.get(sessionId);
    if (!index) {
      index = new SpillIndex(entries);
      this.#indexes.set(sessionId, index);
    }
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return [];
    const hits: SpillHit[] = [];
    entries.forEach((entry, position) => {
      const score = index.scoreAt(position + 1, queryTokens);
      if (score > 0) hits.push({ ...entry, score });
    });
    hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
    return hits.slice(0, k);
  }

  /** Drop oldest entries when the session file exceeds its byte cap (atomic rewrite). */
  #enforceCap(sessionId: string): void {
    const file = this.#file(sessionId);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= this.#maxBytes) return;
    const entries = this.read(sessionId).slice();
    // Write via tmp+rename so a crash mid-rewrite cannot lose the tail.
    const tmp = `${file}.tmp`;
    try {
      while (entries.length > 0) {
        const candidate = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
        if (Buffer.byteLength(candidate, "utf8") <= this.#maxBytes) {
          writeFileSync(tmp, candidate, "utf8");
          renameSync(tmp, file);
          this.#indexes.delete(sessionId);
          this.#entries.delete(sessionId);
          return;
        }
        entries.shift();
      }
      writeFileSync(file, "", "utf8");
    } catch {
      // Best effort; the next compaction will retry the cap.
    }
    this.#indexes.delete(sessionId);
    this.#entries.delete(sessionId);
  }
}
