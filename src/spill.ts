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

import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Single source of truth for the spill directory. Reads the environment at
 * call time (not import time) so the resolved value is always current.
 * `DSH_COMPACT_PLUS_SPILL_DIR` wins when set; otherwise the home-based
 * `.dsh/compaction-spill`. Do NOT point this at a shared or world-writable
 * directory: spilled text is sensitive (see redactSecrets below).
 */
export function defaultSpillDir(): string {
  return process.env.DSH_COMPACT_PLUS_SPILL_DIR ?? join(homedir(), ".dsh", "compaction-spill");
}

/** Test hook: explicit storage for the default (backward-compatible local name). */
export function getDefaultSpillDir(): string {
  return defaultSpillDir();
}

/**
 * Redact API-key-shaped values from spilled text before it touches disk.
 * Covers common provider key prefixes and generic `key=value` secrets.
 * This is heuristic, not exhaustive (URL-embedded passwords, low-entropy
 * tokens, and arbitrary high-entropy strings are NOT caught); treat every
 * spill file as sensitive and rely on the 0600 permissions, not this regex.
 * `shortcut: heuristic redact, upgrade to a secrets scanner when spill leaves localhost.`
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bxai-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?)[^\s"']+/gi, "$1[REDACTED_SECRET]");
}

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
  readonly #spillSecrets: boolean;
  readonly #indexes = new Map<string, SpillIndex>();
  readonly #entries = new Map<string, SpillEntry[]>();

  constructor(
    dir?: string,
    maxBytes: number = DEFAULT_SPILL_OPTIONS.maxBytes,
    spillSecrets: boolean = true,
  ) {
    this.#dir = dir ?? defaultSpillDir();
    this.#maxBytes = maxBytes;
    this.#spillSecrets = spillSecrets;
  }

  #file(sessionId: string): string {
    return join(this.#dir, `${safeFileName(sessionId)}.jsonl`);
  }

  /**
   * Append entries in order, creating the store directory on first use.
   * When `spillSecrets` is true (the default), text passes through
   * redactSecrets before hitting disk. Refuses to follow a symlinked file
   * so a planted symlink cannot redirect writes elsewhere.
   */
  append(sessionId: string, entries: readonly SpillEntry[]): void {
    if (entries.length === 0) return;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = this.#file(sessionId);
    try {
      if (lstatSync(file).isSymbolicLink()) return;
    } catch {
      // File does not exist yet; nothing to refuse.
    }
    const safe = this.#spillSecrets
      ? entries.map((entry) => ({ ...entry, text: redactSecrets(entry.text) }))
      : entries;
    const lines = safe.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    appendFileSync(file, lines, { encoding: "utf8", mode: 0o600 });
    try {
      // appendFileSync mode only applies on create; tighten pre-existing files.
      chmodSync(file, 0o600);
    } catch {
      // Best effort; the file was just written with 0600.
    }
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
          writeFileSync(tmp, candidate, { encoding: "utf8", mode: 0o600 });
          try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
          renameSync(tmp, file);
          this.#indexes.delete(sessionId);
          this.#entries.delete(sessionId);
          return;
        }
        entries.shift();
      }
      writeFileSync(file, "", "utf8");
    } catch {
      // The atomic tmp rewrite can fail (e.g. a directory obstructs <file>.tmp);
      // swallowed, that left the file over cap forever because every retry hit
      // the same obstruction. Fall back to a direct write of the kept suffix so
      // the cap is still enforced, dropping atomicity only on this path.
      try {
        const kept = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
        writeFileSync(file, kept, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Best effort; the next compaction will retry the cap.
      }
    }
    this.#indexes.delete(sessionId);
    this.#entries.delete(sessionId);
  }
}
