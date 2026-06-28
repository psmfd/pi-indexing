/**
 * indexing/parse.ts — parse and classify `ccc search` output (pure).
 *
 * Verified against ccc 0.2.35 (piped, NO_COLOR — zero ANSI). Each hit is:
 *
 *   --- Result N (score: 0.NNN) ---
 *   File: <relpath>:<start>-<end> [<language>]
 *   <content, possibly multi-line>
 *
 * blocks separated by a blank line. `ccc` exits 0 even when uninitialized,
 * emitting `Error: Not in an initialized project directory.` to stdout — so
 * classification reads the output, not just the exit code.
 */

import type { ClassifiedOutput, SearchResult } from "./types.ts";

const RESULT_HEADER = /--- Result \d+ \(score:/;

// One result block: header, File line, then content lazily up to the next
// header or end of output.
const RESULT_BLOCK =
  /--- Result \d+ \(score: ([\d.]+)\) ---\nFile: (.+?):(\d+)-(\d+) \[([^\]]*)\]\n([\s\S]*?)(?=\n--- Result \d+ \(score:|\s*$)/g;

/** Parse all result blocks from raw search stdout. */
export function parseSearchResults(raw: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const m of raw.matchAll(RESULT_BLOCK)) {
    results.push({
      score: Number.parseFloat(m[1] ?? "0"),
      file: m[2] ?? "",
      startLine: Number.parseInt(m[3] ?? "0", 10),
      endLine: Number.parseInt(m[4] ?? "0", 10),
      language: m[5] ?? "",
      content: (m[6] ?? "").replace(/\s+$/, ""),
    });
  }
  return results;
}

/**
 * Classify a completed search invocation. `spawnError` (e.g. ENOENT) is fatal;
 * the uninitialized-project banner is detected by content; an explicit `Error:`
 * line or a non-zero exit with no parseable results is an error; otherwise the
 * (possibly empty) parsed results are returned.
 */
export function classifyOutput(
  stdout: string,
  code: number | null,
  spawnError?: string,
): ClassifiedOutput {
  if (spawnError) {
    return { kind: "error", results: [], message: spawnError };
  }
  if (/^Error: Not in an initialized project/m.test(stdout)) {
    return {
      kind: "not-initialized",
      results: [],
      message: "the project is not indexed — run `ccc init && ccc index` (or /index build)",
    };
  }
  const results = parseSearchResults(stdout);
  if (results.length > 0) {
    return { kind: "results", results, message: "" };
  }
  const errorLine = stdout.split("\n").find((l) => l.startsWith("Error:"));
  if (errorLine) {
    return { kind: "error", results: [], message: errorLine.replace(/^Error:\s*/, "") };
  }
  if (code !== null && code !== 0 && !RESULT_HEADER.test(stdout)) {
    return { kind: "error", results: [], message: `ccc search exited ${code}` };
  }
  return { kind: "empty", results: [], message: "" };
}
